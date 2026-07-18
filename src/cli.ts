#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { PolicySchema, type GateResult, type Policy, type Receipt, type Verdict } from "./types.js";
import {
  shapeCheck,
  computeDiffSha256,
  gitDiffExcludingReceipt,
  gitDiffExcludingReceiptFrom,
  gitChangedFiles,
  gitChangedFilesFrom,
  gitMergeBase,
  isReceiptPath,
} from "./shape.js";
import {
  semanticReview,
  resolveReviewModel,
  PROMPT_VERSION,
  resolveUnavailableVerdict,
} from "./review.js";
import { selectProvider } from "./provider.js";
import { shouldSkipReview, readReviewCache, writeReviewCache, protectedFloor } from "./cost.js";
import {
  renderComment,
  renderCiSummary,
  verifyCiEvidence,
  fetchExistingGateComment,
  countRounds,
  extractPriorCapsule,
  publishCheckRun,
  getPrHeadSha,
  fileFollowUps,
  fileConsolidatedFollowUps,
  closeFollowUpOnMerge,
  enableAutoMerge,
  InfraError,
} from "./github.js";
import { verdictPresentation } from "./verdict.js";
import { renderPreflight } from "./preflight.js";
import { detectCi, reportToCi } from "./ci.js";
import { pickReceipt, type ReceiptCandidate } from "./receipt-select.js";
import { runInit, sanitizeTaskId, newReceipt, formatSchemaReference, resolveStack } from "./scaffold.js";
import { isStackId, runMigrationGuard } from "./stack.js";
import { setupProtection } from "./protection.js";
import { detectBaseRef } from "./base.js";
import { baseDir, resolveDualPath } from "./basedir.js";
import {
  protectedHits,
  refreshMechanical,
  checkMechanical,
  JUDGMENT_CHECKLIST,
  type MechanicalFields,
} from "./receipt-write.js";
import { runPropose } from "./propose.js";
import { runArchive } from "./archive.js";
import { resolveSeverity } from "./severity.js";
import { generateReceipt } from "./receipt-generate.js";

function loadPolicy(path: string): Policy {
  if (!existsSync(path)) {
    console.error(`plumb: policy file not found at ${path} — using defaults`);
    return PolicySchema.parse({ version: "1.0" });
  }
  return PolicySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function getDiff(baseRef: string, cwd: string): string {
  return execFileSync("git", ["diff", `${baseRef}...HEAD`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * One-line summaries of the commits on this branch since it forked from the
 * base — the "fix commits" fed into a convergent re-review (#41). Best-effort:
 * returns [] if git is unavailable. Capped so a long branch can't blow the
 * prompt budget.
 */
function fixCommitsSince(baseRef: string, cwd: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["log", "--no-merges", "--format=%h %s", "-n", "30", `${baseRef}..HEAD`],
      { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Redundant protected-path / self_modifying floor for the skip path. Reads the
 * ACTUAL changed files from git (best-effort) so the floor isn't only trusting
 * the receipt's self-report, then delegates to the pure `protectedFloor`.
 * Returns a reason string when review MUST be enforced, else null.
 */
function protectedFloorHit(
  receipt: Receipt,
  policy: Policy,
  baseRef: string | undefined,
  cwd: string,
  skipGit: boolean,
): string | null {
  let actual: string[] = [];
  if (!skipGit && baseRef) {
    try {
      actual = gitChangedFiles(baseRef, cwd).filter((f) => !isReceiptPath(f));
    } catch {
      /* git unavailable — fall back to receipt-declared files only */
    }
  }
  return protectedFloor(receipt, policy, actual);
}

/**
 * Pre-push hygiene warnings (non-fatal). The two traps an author hits locally:
 *  1. A shared `.proofgate/receipt.json` — the anti-pattern that drags the last
 *     receipt forward across branches and conflicts. Use one file per PR.
 *  2. Uncommitted changes — the gate binds the COMMITTED HEAD via the 3-dot
 *     `git diff <base>...HEAD`, so working-tree edits are NOT in diff_sha256.
 */
function preflightWarnings(cwd: string, baseRef: string): void {
  for (const d of [".plumbline", ".proofgate"]) {
    if (existsSync(join(cwd, d, "receipt.json"))) {
      console.error(
        `plumb ⚠️  legacy ${d}/receipt.json present — use one file per PR at ` +
          `${d}/receipts/<task_id>.json (a shared receipt.json gets dragged forward ` +
          "across branches and conflicts). `plumb new` creates the per-PR file.",
      );
    }
  }
  try {
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
    if (dirty) {
      console.error(
        `plumb ⚠️  uncommitted changes present. The gate binds the COMMITTED HEAD via ` +
          `\`git diff ${baseRef}...HEAD\` (3-dot) — uncommitted edits are NOT in diff_sha256. ` +
          `Commit, then re-run \`plumb receipt --write\` so the hash matches what CI computes.`,
      );
    }
  } catch {
    /* not a git repo / git unavailable — skip */
  }
}

function defaultReceipt(dir: string): string {
  return `${dir}/receipt.json`;
}

/**
 * Locate the receipt for THIS PR. Per-PR receipts live at
 * `.proofgate/receipts/<task_id>.json` — one file per PR, so concurrent
 * PRs never collide on a shared receipt (the single biggest blocker to
 * running many agent PRs at once). We find the one added/modified in this
 * PR's diff. Falls back to the legacy single-file path when none is found
 * or git isn't available, so existing repos keep working unchanged. An
 * explicit non-default --receipt always wins.
 */
/**
 * Uncommitted per-PR receipts (#49): untracked or unstaged files under
 * `.plumbline/receipts/` (or legacy `.proofgate/`), read from
 * `git status --porcelain`. Lets the LOCAL pre-flight discover a receipt the
 * agent just wrote but hasn't `git add`ed yet — the exact first-run trap.
 * Returns [] on any git error (caller falls back to the diff-based path).
 */
export function uncommittedReceipts(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd,
      encoding: "utf8",
    });
    return out
      .split("\n")
      // porcelain format: 2 status chars + space + path (+ optional "orig -> new").
      .map((l) => l.slice(3).trim())
      .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p))
      .filter((f) => /^\.(?:plumbline|proofgate)\/receipts\/[^/]+\.json$/.test(f));
  } catch {
    return [];
  }
}

function resolveReceiptPath(
  explicit: string,
  baseRef: string | undefined,
  cwd: string,
  skipGit: boolean,
  fallback: string,
  allowUntracked = false,
): string {
  if (explicit !== fallback) return explicit;
  if (skipGit || !baseRef) return fallback;
  let changed: string[] = [];
  try {
    changed = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=AMR", `${baseRef}...HEAD`],
      { cwd, encoding: "utf8" },
    )
      .split("\n")
      .map((l) => l.trim())
      .filter((f) => /^\.(?:plumbline|proofgate)\/receipts\/[^/]+\.json$/.test(f));
  } catch {
    return fallback;
  }
  // First-run ergonomics (#49): the diff sees only COMMITTED changes, so a
  // freshly-written but not-yet-committed receipt under receipts/ is invisible
  // and discovery falls back to the (missing) single-file path → "no receipt
  // found". Locally, also consider UNTRACKED / unstaged receipts via
  // `git status --porcelain` so `plumb check` works BEFORE `git add`. CI stays
  // strictly diff-based (allowUntracked=false) — a receipt must be committed to
  // gate a PR — so this changes only the local pre-flight, never the gate.
  if (changed.length === 0 && allowUntracked) {
    const untracked = uncommittedReceipts(cwd);
    if (untracked.length === 1) return untracked[0];
    if (untracked.length > 1) {
      throw new Error(
        `plumb: ${untracked.length} uncommitted receipts under receipts/ ` +
          `(${untracked.join(", ")}) — pass --receipt to select which one to check.`,
      );
    }
  }
  if (changed.length === 1) return changed[0];
  if (changed.length > 1) {
    // More than one per-PR receipt in the diff — usually a merge re-added an
    // old branch's receipt next to this PR's real one. DON'T grab the first
    // (that's how the gate evaluated the wrong receipt and failed a correct
    // PR). Disambiguate by task_id↔branch / diff_sha256 binding, or fail loudly.
    const candidates: ReceiptCandidate[] = changed.map((p) => {
      try {
        const j = JSON.parse(readFileSync(join(cwd, p), "utf8")) as {
          task_id?: unknown;
          diff_sha256?: unknown;
        };
        return {
          path: p,
          taskId: typeof j.task_id === "string" ? j.task_id : undefined,
          diffSha256: typeof j.diff_sha256 === "string" ? j.diff_sha256 : undefined,
        };
      } catch {
        return { path: p };
      }
    });
    let actualSha: string | undefined;
    try {
      actualSha = computeDiffSha256(gitDiffExcludingReceipt(baseRef, cwd));
    } catch {
      // git unavailable for the binding hash — fall back to branch/explicit-fail.
    }
    const branch = process.env.GITHUB_HEAD_REF || undefined;
    return pickReceipt(candidates, { branch, actualSha });
  }
  return fallback;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const ci = detectCi();
  const cwd = arg("cwd", process.cwd())!;
  // `.plumbline/` is canonical; `.proofgate/` (the pre-rename dir) still fully
  // works — reads and writes follow whichever the repo already has.
  const dir = baseDir(cwd);
  const DEFAULT_RECEIPT = defaultReceipt(dir);
  const policyPath = resolveDualPath(cwd, arg("policy", `${dir}/policy.json`)!);
  const baseRef = arg("base", ci.baseRef ?? detectBaseRef(cwd))!;
  const skipGit = flag("no-git");
  // Phased gate (#58, v0.6.0): fail-cheap-first. `--phase` splits the CI `run`
  // gate into cheap-then-expensive stages so the agent's iterate loop spins
  // against the ~2-min shape+semantic phase, not the ~30-min test phase.
  //   full    (default) — today's all-in-one: shape + ci-evidence + semantic.
  //   quality (phase 1) — shape + semantic ONLY; ci-evidence is SKIPPED (tests
  //                       haven't run). REWORK => fail fast so `needs:` blocks
  //                       phase 2; else a clean "quality passed" (exit 0).
  //   verify  (phase 2) — ci-evidence gate + terminal verdict; assumes phase 1
  //                       passed. Same dimensions as `full`.
  // Default `full` keeps back-compat for non-staged consumers (Cuspr/nuvola).
  const phase = arg("phase", "full")!;
  if (!["full", "quality", "verify"].includes(phase)) {
    console.error(`plumb: unknown --phase "${phase}" (known: full | quality | verify)`);
    return 2;
  }
  // ci-evidence runs in every phase EXCEPT quality (phase 1 runs before tests).
  const runCiEvidence = phase !== "quality";
  // init/new don't operate on an existing receipt — skip resolution (and its
  // git call, which would print a spurious diff error in a fresh repo).
  // "auto" (and either dir's legacy default path — what pinned actions pass)
  // means "discover the per-PR receipt"; anything else is an explicit override.
  const receiptArg = arg("receipt", "auto")!;
  const receiptIsDefault =
    receiptArg === "auto" ||
    receiptArg === ".plumbline/receipt.json" ||
    receiptArg === ".proofgate/receipt.json";
  const receiptPath =
    cmd === "init" || cmd === "new" || cmd === "schema" || cmd === "propose" || cmd === "archive" ||
    cmd === "setup-protection" || cmd === "migration-guard" || cmd === "followups"
      ? DEFAULT_RECEIPT
      : resolveReceiptPath(
          receiptIsDefault ? DEFAULT_RECEIPT : receiptArg,
          skipGit ? undefined : baseRef,
          cwd,
          skipGit,
          DEFAULT_RECEIPT,
          // #49: allow untracked-receipt discovery only for LOCAL pre-flight
          // commands (not the CI `run` gate, which stays diff-based). CI is
          // detected by ci.provider; `run` is excluded belt-and-suspenders.
          ci.provider === "none" && cmd !== "run",
        );

  if (!cmd || !["init", "new", "schema", "shape", "review", "run", "stamp", "check", "receipt", "propose", "archive", "setup-protection", "migration-guard", "followups"].includes(cmd)) {
    console.log(`plumbline — the plumb line for AI agent work (Amos 7:7-8): proof-carrying gate

usage:
  plumb init    [--stack rust-sqlx] [--no-stack] [--protect]   (scaffold the governed CI into this
                repo: gate workflow WITH ci-evidence poll-wait + .plumbline/ + AGENTS.md, and — on a
                detected stack — the stack preset (rust-sqlx: migration guard + rust-cache CI). Start here.)
  plumb setup-protection --repo owner/name [--branch b] [--check name ...] [--dry-run] [--force]
                (make the plumbline gate + the repo's CI checks REQUIRED on the default branch
                 (strict:false) and enable auto-merge — the 'blocking + auto-merge on all green' shape.
                 NON-DESTRUCTIVE: reads current protection first and PRESERVES existing required
                 reviewers + push restrictions (only ADDS checks; never nulls them). Refuses to write
                 if it can't read current protection — pass --force to override. Idempotent; prints
                 what it changed. Needs GITHUB_TOKEN with repo-admin scope.)
  plumb migration-guard [--base ref] [--dir migrations]   (fail if a new migration's version <= the
                base branch's max — the collision guard the rust-sqlx CI job runs)
  plumb propose "<title>" [--body text] [--repo owner/name] [--lite] [--task id]
                (intake: open the GitHub issue + scaffold openspec/changes/<slug>/ born linked;
                 --lite = plain issue, no contract folder — for trivial work)
  plumb new     [--task id] [--agent id] [--base ref]   (scaffold a fresh per-PR receipt, diff-stamped)
  plumb receipt --write [--task id] [--agent id]   (one idempotent step: scaffold if absent, else refresh
                the mechanical fields — diff_sha256, changed_files, self_modifying — judgment fields untouched)
  plumb receipt --check   (mechanical staleness only; exit 1 if stale — pre-push-hook friendly)
  plumb receipt generate --intent "<what/why>" [--summary "<result>"] [--task id] [--agent id]
                (auto-synthesize a conformant, HONEST receipt for a machine-authored/MCP change:
                 validation deferred to repo CI (ci_covered — no fabricated local test run),
                 self_modifying auto-detected from protected_paths. Idempotent. Makes MCP PRs
                 proof-carrying by construction: green-CI + non-protected → PASS.)
  plumb schema  (print the receipt field reference — every field + allowed enum values)
  plumb stamp   [--receipt path] [--base ref]   (fill diff_sha256 + changed_files from the real diff)
  plumb check   [--receipt path] [--policy path] [--base ref] [--review]   (local pre-flight: shape + diff_sha256 only; --review also runs the semantic review for the full verdict)
  plumb shape   [--receipt path] [--policy path] [--base ref] [--no-git]
  plumb review  [--receipt path] [--policy path] [--base ref] [--mission path]
  plumb run     [--receipt path] [--policy path] [--base ref] [--phase quality|verify|full]
                (CI gate: shape + review + PR comment. --phase splits it fail-cheap-first:
                 quality = shape + semantic only (ci-evidence SKIPPED — tests not yet run; REWORK fails fast);
                 verify  = ci-evidence + terminal verdict (assumes phase 1 passed);
                 full    = all-in-one (default; back-compat for non-staged consumers).)
  plumb followups close [--pr N] [--repo owner/name]   (close a merged PR's consolidated follow-up issue;
                run on 'pull_request: closed' — most follow-ups are stale-by-design once the PR lands)
  plumb archive <slug> [--force] [--date YYYY-MM-DD]   (apply the change's spec deltas to the living
                openspec/specs/, move the change to openspec/changes/archive/<date>-<slug>/;
                refuses unless the change's receipt passes the gate — --force overrides with a warning)

receipt: auto-discovered from the PR diff at .plumbline/receipts/<task_id>.json
         (one file per PR — no conflicts); falls back to <dir>/receipt.json.
         Legacy .proofgate/ repos work unchanged. Pass --receipt to override.
policy default:  .plumbline/policy.json (or .proofgate/policy.json when that's what exists)
env: ANTHROPIC_API_KEY (default provider), GITHUB_TOKEN + GITHUB_REPOSITORY + PR number (comment),
     PLUMBLINE_MODEL / PROOFGATE_MODEL (model override),
     PLUMBLINE_PROVIDER (anthropic|openai), PLUMBLINE_API_BASE + PLUMBLINE_API_KEY (OpenAI-compatible)`);
    return cmd ? 2 : 0;
  }

  // --- schema: print the receipt field reference (no policy/receipt/git needed) ---
  if (cmd === "schema") {
    console.log(formatSchemaReference());
    return 0;
  }

  // --- init: scaffold the gate into this repo (no policy/receipt needed) ---
  if (cmd === "init") {
    const stackArg = arg("stack");
    if (stackArg && !isStackId(stackArg)) {
      console.error(`plumb init: unknown --stack "${stackArg}" (known: rust-sqlx)`);
      return 2;
    }
    const forced = stackArg && isStackId(stackArg) ? stackArg : undefined;
    const noStack = flag("no-stack");
    const stack = noStack ? undefined : resolveStack(cwd, forced);
    if (stack) {
      console.error(`stack: ${stack}${forced ? " (--stack)" : " (auto-detected)"}`);
    } else if (!noStack) {
      console.error(`stack: none detected (core-only) — force one with --stack rust-sqlx`);
    }
    for (const it of runInit(cwd, { stack: forced, noStack })) {
      console.error(`  ${it.created ? "created" : "skip   "} ${it.dest}${it.note ? `  (${it.note})` : ""}`);
    }
    // --protect: run setup-protection inline (needs a repo + admin token).
    if (flag("protect")) {
      const repo = arg("repo") ?? process.env.GITHUB_REPOSITORY;
      const token = process.env.GITHUB_TOKEN;
      if (!repo || !token) {
        console.error(
          `\nplumb init --protect: needs --repo owner/name (or GITHUB_REPOSITORY) and GITHUB_TOKEN with repo-admin scope. ` +
            `Run 'plumb setup-protection --repo owner/name' once the workflow has run.`,
        );
      } else {
        try {
          const res = await setupProtection({ repo, token, gateCheck: "plumbline" });
          console.error(`\nprotection on ${repo}@${res.branch}:`);
          for (const c of res.changes) console.error(`  · ${c}`);
        } catch (e) {
          console.error(`\nplumb init --protect: ${String(e)}`);
        }
      }
    }
    console.error(
      `\nplumbline initialized. Next:\n` +
        `  1. Read ${dir}/AGENTS.md (the agent guide)\n` +
        `  2. plumb receipt --write  →  fill the judgment fields  →  plumb check\n` +
        `  3. (human) plumb setup-protection --repo owner/name  +  add the ANTHROPIC_API_KEY secret — steps in AGENTS.md`,
    );
    return 0;
  }

  // --- setup-protection: the human-only half, via the GitHub API ---
  // Make the gate + the repo's CI checks REQUIRED on the default branch
  // (strict:false) and enable auto-merge — the "blocking + auto-merge on all
  // green" shape. Idempotent; prints the diff. Needs a repo-admin token.
  if (cmd === "setup-protection") {
    const repo = arg("repo") ?? process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    if (!repo) {
      console.error("plumb setup-protection: --repo owner/name is required (or set GITHUB_REPOSITORY)");
      return 2;
    }
    if (!token) {
      console.error("plumb setup-protection: GITHUB_TOKEN with repo-admin scope is required");
      return 2;
    }
    // Extra required checks: --check may repeat.
    const checks: string[] = [];
    for (let i = 0; i < process.argv.length; i++) {
      if (process.argv[i] === "--check" && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
        checks.push(process.argv[i + 1]);
      }
    }
    try {
      const res = await setupProtection({
        repo,
        token,
        branch: arg("branch"),
        checks,
        gateCheck: arg("gate-check", "plumbline"),
        dryRun: flag("dry-run"),
        force: flag("force"),
      });
      console.error(`${flag("dry-run") ? "[dry-run] " : ""}protection on ${repo}@${res.branch}:`);
      for (const c of res.changes) console.error(`  · ${c}`);
      console.error(
        `\nrequired checks now: [${res.requiredChecks.join(", ")}] (strict:false) · auto-merge: ${res.autoMergeEnabled ? "enabled" : "off"}`,
      );
    } catch (e) {
      console.error(`plumb setup-protection: ${String(e)}`);
      return 1;
    }
    return 0;
  }

  // --- migration-guard: fail a PR whose new migration collides with base ---
  // The pure logic lives in stack.ts (checkMigrationCollision) so it's unit-
  // testable; here we read the two file lists from git and report.
  if (cmd === "migration-guard") {
    if (skipGit || !baseRef) {
      console.error("plumb migration-guard: needs git + a --base ref");
      return 1;
    }
    const res = runMigrationGuard(cwd, baseRef, arg("dir", "migrations")!);
    if (res.ok) {
      console.error(
        `✓ migration-guard PASS — ${res.added.length} new migration(s), all sort after base max ${res.baseMax}.`,
      );
      return 0;
    }
    for (const e of res.errors) console.error(`migration-guard ❌ ${e}`);
    return 1;
  }

  // --- followups close: auto-close a merged PR's consolidated follow-up (v0.7.0) ---
  // Meant to run on `pull_request: closed` (merged): most follow-ups are
  // stale-by-design once the PR lands, so close the ONE consolidated issue.
  // Best-effort — never fails the workflow.
  if (cmd === "followups") {
    const sub = process.argv[3];
    if (sub !== "close") {
      console.error(`plumb followups: only 'close' is supported — plumb followups close [--pr N] [--repo owner/name]`);
      return 2;
    }
    const repo = arg("repo") ?? process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    const prArg = arg("pr") ?? process.env.PLUMBLINE_PR_NUMBER ?? ci.prNumber?.toString();
    if (!repo || !token || !prArg) {
      console.error("plumb followups close: needs --repo owner/name, GITHUB_TOKEN, and --pr N (or a PR context).");
      return 2;
    }
    const closed = await closeFollowUpOnMerge(repo, Number(prArg), token);
    console.error(
      closed !== null
        ? `closed consolidated follow-up issue #${closed} for merged PR #${prArg}`
        : `no open consolidated follow-up issue to close for PR #${prArg}`,
    );
    return 0;
  }

  // --- propose: intake — issue + OpenSpec contract folder, born linked ---
  // The upstream end of the loop (propose → work → prove → gate). Deterministic
  // scaffolding only: folder, stubs, issue, linkage, an informational
  // self_modifying prediction. Spec content stays TODO — authored, never generated.
  if (cmd === "propose") {
    const title = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined;
    if (!title) {
      console.error(`plumb propose: a title is required — plumb propose "<the ask>" [--body text] [--repo owner/name] [--lite] [--task id]`);
      return 2;
    }
    const proposePolicy = loadPolicy(policyPath);
    const res = runPropose({
      title,
      body: arg("body"),
      repo: arg("repo"),
      lite: flag("lite"),
      task: arg("task"),
      cwd,
      protectedPaths: proposePolicy.protected_paths,
    });
    if (res.folder) {
      console.error(
        `\nNext: fill ${res.folder}/proposal.md (Why / What Changes / Scope) + tasks.md, get the contract approved, ` +
          `then work → 'plumb receipt --write'${res.issueNumber ? ` (task_id ${res.issueNumber} is already linked)` : ""}.`,
      );
    }
    return 0;
  }

  // --- archive: close the loop — apply spec deltas to living specs, move the change ---
  // Gate-before-archive: only proven work becomes recorded truth. Deterministic
  // merges per OpenSpec semantics (ADDED append / MODIFIED replace / REMOVED delete).
  if (cmd === "archive") {
    const slug = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined;
    if (!slug) {
      console.error("plumb archive: a change slug is required — plumb archive <slug> [--force] [--date YYYY-MM-DD]");
      return 2;
    }
    const res = runArchive({
      slug,
      cwd,
      force: flag("force"),
      policy: loadPolicy(policyPath),
      date: arg("date"),
    });
    for (const e of res.errors) console.error(`plumb archive ❌ ${e}`);
    if (res.ok) {
      console.error(`\nCommit the archive: git add openspec/ && git commit -m "chore(openspec): archive ${slug}"`);
    }
    return res.ok ? 0 : 1;
  }

  // --- new: scaffold a fresh per-PR receipt, stamped to the current diff ---
  if (cmd === "new") {
    let branch = process.env.GITHUB_HEAD_REF || "";
    if (!branch) {
      try {
        branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd,
          encoding: "utf8",
        }).trim();
      } catch {
        /* no git / detached — fall back below */
      }
    }
    const taskId = sanitizeTaskId(arg("task", branch || "TASK")!);
    // PROOFGATE_AGENT_ID is a legacy alias (proofgate→Plumbline rename), retained for back-compat.
    const agentId = arg("agent", process.env.PLUMBLINE_AGENT_ID || process.env.PROOFGATE_AGENT_ID || "agent")!;
    let diffSha: string | undefined;
    let changed: string[] | undefined;
    let baseSha: string | undefined;
    if (!skipGit && baseRef) {
      try {
        baseSha = gitMergeBase(baseRef, cwd) ?? undefined;
        diffSha = computeDiffSha256(
          baseSha ? gitDiffExcludingReceiptFrom(baseSha, cwd) : gitDiffExcludingReceipt(baseRef, cwd),
        );
        changed = (baseSha ? gitChangedFilesFrom(baseSha, cwd) : gitChangedFiles(baseRef, cwd)).filter(
          (f) => !isReceiptPath(f),
        );
      } catch {
        /* leave placeholders; author runs `plumb receipt --write` later */
      }
    }
    const dest = join(cwd, dir, "receipts", `${taskId}.json`);
    if (existsSync(dest)) {
      console.error(
        `plumb new: ${dir}/receipts/${taskId}.json already exists — left as-is. ` +
          `Edit it, then run 'plumb receipt --write' + 'plumb check'.`,
      );
      return 0;
    }
    mkdirSync(dirname(dest), { recursive: true });
    const receipt = newReceipt({ taskId, agentId, diffSha256: diffSha, changedFiles: changed, baseSha });
    writeFileSync(dest, `${JSON.stringify(receipt, null, 2)}\n`);
    console.error(
      `created ${dir}/receipts/${taskId}.json (diff-stamped: ${diffSha ? "yes" : "no — run 'plumb receipt --write'"})\n` +
        `Fill intent / validation_plan / execution_evidence / result_summary, then: plumb receipt --write && plumb check`,
    );
    return 0;
  }

  const policy = loadPolicy(policyPath);

  // --- receipt: automate the mechanical half (bookkeeping), never the judgment ---
  // `--write` is idempotent: scaffold the per-PR receipt if absent, else refresh
  // ONLY diff_sha256 / changed_files / self_modifying (judgment fields preserved
  // byte-for-byte). `--check` verifies mechanical freshness (exit 1 when stale) —
  // small enough for a pre-push hook. self_modifying is DERIVED from
  // policy.protected_paths with the gate's own glob matcher, so scaffold and
  // gate can never disagree — hand-computing these fields is the entire failure
  // class this command removes.
  if (cmd === "receipt") {
    // `plumb receipt generate` (subcommand) or `--generate`: auto-synthesize a
    // conformant, HONEST receipt for a machine-authored (MCP) change (v0.7.0).
    const generate = process.argv[3] === "generate" || flag("generate");
    const write = flag("write");
    const checkOnly = flag("check");
    if (skipGit || !baseRef) {
      console.error("plumb receipt: needs git + a base ref to compute the diff");
      return 1;
    }

    if (generate) {
      let branch = process.env.GITHUB_HEAD_REF || "";
      if (!branch) {
        try {
          branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd,
            encoding: "utf8",
          }).trim();
        } catch {
          /* detached/no git — sanitizeTaskId falls back to TASK */
        }
      }
      const taskId = sanitizeTaskId(arg("task", branch || "TASK")!);
      const agentId = arg("agent", process.env.PLUMBLINE_AGENT_ID || process.env.PROOFGATE_AGENT_ID || "mcp-agent")!;
      const intent = arg("intent") ?? arg("summary");
      if (!intent) {
        console.error(
          `plumb receipt generate: --intent "<what this change is for>" is required ` +
            `(the human's ask — used as the receipt's intent). Optional: --summary "<result>".`,
        );
        return 2;
      }
      let diffSha: string;
      let changed: string[];
      let baseSha: string | undefined;
      try {
        baseSha = gitMergeBase(baseRef, cwd) ?? undefined;
        diffSha = computeDiffSha256(
          baseSha ? gitDiffExcludingReceiptFrom(baseSha, cwd) : gitDiffExcludingReceipt(baseRef, cwd),
        );
        changed = (baseSha ? gitChangedFilesFrom(baseSha, cwd) : gitChangedFiles(baseRef, cwd)).filter(
          (f) => !isReceiptPath(f),
        );
      } catch (e) {
        console.error(`plumb receipt generate: git failed: ${String(e)}`);
        return 1;
      }
      if (changed.length === 0) {
        console.error(
          `plumb receipt generate: no changed files vs ${baseRef} — nothing to attest. Commit the change first.`,
        );
        return 1;
      }
      const receipt = generateReceipt({
        taskId,
        agentId,
        intent,
        summary: arg("summary"),
        changedFiles: changed,
        diffSha256: diffSha,
        baseSha,
        protectedPaths: policy.protected_paths,
        ciEvidenceChecks: policy.ci_evidence_checks,
      });
      const dest = join(dir, "receipts", `${taskId}.json`);
      const destAbs = join(cwd, dest);
      mkdirSync(dirname(destAbs), { recursive: true });
      // Idempotent: re-running on the same diff rewrites the same bytes.
      writeFileSync(destAbs, `${JSON.stringify(receipt, null, 2)}\n`);
      console.error(
        `generated ${dest} (base ${baseRef}${baseSha ? `, pinned @ ${baseSha.slice(0, 12)}…` : ""})\n` +
          `  self_modifying: ${receipt.self_modifying} ` +
          `(${receipt.self_modifying ? "protected surface → routes to REVIEW" : "non-protected → PASS-eligible"})\n` +
          `  validation: deferred to repo CI (ci_covered) — HONEST: no local test run is claimed.\n` +
          `  changed_files (${changed.length}): ${changed.join(", ")}\n\n` +
          `Commit the receipt with the change; the gate corroborates CI on the PR. Pre-check: plumb check`,
      );
      return 0;
    }

    if (write === checkOnly) {
      console.error("plumb receipt: pass exactly one of --write | --check | generate");
      return 2;
    }
    let mech: MechanicalFields;
    try {
      // Pin the diff base: resolve the merge-base ONCE and compute the hash +
      // file list against that exact commit (2-dot), so the receipt records the
      // base and the gate verifies deterministically against it. Falls back to
      // the live 3-dot when the merge-base can't be resolved (shallow clone / no
      // common ancestor) so `receipt --write` never hard-fails on the pin.
      const baseSha = gitMergeBase(baseRef, cwd) ?? undefined;
      const changed = (baseSha ? gitChangedFilesFrom(baseSha, cwd) : gitChangedFiles(baseRef, cwd)).filter(
        (f) => !isReceiptPath(f),
      );
      mech = {
        diffSha256: computeDiffSha256(
          baseSha ? gitDiffExcludingReceiptFrom(baseSha, cwd) : gitDiffExcludingReceipt(baseRef, cwd),
        ),
        changedFiles: changed,
        hits: protectedHits(changed, policy.protected_paths),
        baseSha,
      };
    } catch (e) {
      console.error(`plumb receipt: git failed: ${String(e)}`);
      return 1;
    }

    // Target: the PR's discovered receipt; never the legacy shared receipt.json.
    let dest = receiptPath;
    if (dest === DEFAULT_RECEIPT) {
      let branch = process.env.GITHUB_HEAD_REF || "";
      if (!branch) {
        try {
          branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd,
            encoding: "utf8",
          }).trim();
        } catch {
          /* detached/no git — sanitizeTaskId falls back to TASK */
        }
      }
      const taskId = sanitizeTaskId(arg("task", branch || "TASK")!);
      dest = join(dir, "receipts", `${taskId}.json`);
    }
    const destAbs = join(cwd, dest);

    if (checkOnly) {
      if (!existsSync(destAbs)) {
        console.error(`plumb receipt --check: no receipt at ${dest} — run 'plumb receipt --write'`);
        return 1;
      }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(readFileSync(destAbs, "utf8"));
      } catch (e) {
        console.error(`plumb receipt --check: ${dest} is not valid JSON: ${String(e)}`);
        return 1;
      }
      const report = checkMechanical(obj, mech);
      if (report.fresh) {
        console.error(`✓ ${dest} mechanical fields are fresh (diff_sha256 matches the committed diff)`);
        return 0;
      }
      for (const p of report.problems) console.error(`stale ❌ ${p}`);
      console.error("✗ receipt is stale — run 'plumb receipt --write' to refresh, then commit.");
      return 1;
    }

    // --write
    if (!existsSync(destAbs)) {
      const taskId = sanitizeTaskId(arg("task", dest.replace(/^.*\/|\.json$/g, ""))!);
      // PROOFGATE_AGENT_ID is a legacy alias (proofgate→Plumbline rename), retained for back-compat.
      const agentId = arg("agent", process.env.PLUMBLINE_AGENT_ID || process.env.PROOFGATE_AGENT_ID || "agent")!;
      const receipt = newReceipt({
        taskId,
        agentId,
        diffSha256: mech.diffSha256,
        changedFiles: mech.changedFiles,
        baseSha: mech.baseSha,
      });
      if (mech.hits.length > 0) {
        receipt.self_modifying = true;
        console.error(
          `self_modifying: true (protected paths touched: ${mech.hits
            .map((h) => `${h.file} matches ${h.glob}`)
            .join(", ")})`,
        );
      }
      mkdirSync(dirname(destAbs), { recursive: true });
      writeFileSync(destAbs, `${JSON.stringify(receipt, null, 2)}\n`);
      console.error(`created ${dest} — mechanical fields filled from the real diff (base ${baseRef}).`);
    } else {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(readFileSync(destAbs, "utf8"));
      } catch (e) {
        console.error(`plumb receipt --write: ${dest} is not valid JSON: ${String(e)}`);
        return 1;
      }
      const { receipt, notes, changed } = refreshMechanical(obj, mech);
      if (changed) writeFileSync(destAbs, `${JSON.stringify(receipt, null, 2)}\n`);
      for (const n of notes) console.error(`  ${n}`);
      console.error(
        changed
          ? `refreshed ${dest} — mechanical fields updated; judgment fields untouched.`
          : `${dest} already fresh — nothing to do.`,
      );
    }
    console.error(`\nNow fill the judgment fields (the tool never writes these):`);
    for (const j of JUDGMENT_CHECKLIST) console.error(`  · ${j}`);

    // Write-time shape discipline (#53, point 2): run the SAME shapeCheck the
    // gate runs and, if it FAILS on evidence-coverage, name the exact required
    // steps still lacking execution_evidence right here — so the author fixes it
    // now, not after a 25-min CI round-trip. This is the same unified shape
    // logic used by `plumb check` and the CI `run` gate; it cannot drift. We
    // warn (never auto-fill judgment) — filling execution_evidence for the
    // author would defeat proof-carrying work.
    try {
      const raw = readFileSync(destAbs, "utf8");
      const { result: shape } = shapeCheck(raw, policy, { baseRef, cwd, skipGit: false });
      const evidenceGaps = shape.errors.filter((e) => e.startsWith("no execution evidence for required step"));
      if (evidenceGaps.length > 0) {
        console.error(
          `\n⚠️  This receipt would FAIL the gate (shape) as written — the SAME check the CI gate runs:`,
        );
        for (const g of evidenceGaps) console.error(`   shape ❌ ${g}`);
        console.error(
          `   Add an execution_evidence entry (command + status) for each required step above ` +
            `(or mark the step ci_covered:true if a CI check corroborates it). Run 'plumb check' to confirm before pushing.`,
        );
      }
    } catch {
      /* best-effort — never fail `receipt --write` on the advisory shape probe */
    }
    console.error(`\nThen: git add ${dest} && commit && push  (pre-check: plumb check)`);
    return 0;
  }

  if (!existsSync(receiptPath)) {
    console.error(
      `plumb: no receipt found at ${receiptPath}.\n` +
        `Agent work must ship with a proof receipt. See templates/receipt.example.json.`,
    );
    return 1;
  }
  const rawReceipt = readFileSync(receiptPath, "utf8");

  // --- stamp: fill the mechanical fields from the real diff, then exit (#5) ---
  // diff_sha256 + changed_files are the most error-prone fields (they change on
  // every edit/rebase). Generate them with the exact computation the gate uses,
  // so the author never hand-maintains them or fails the gate on a stale hash.
  if (cmd === "stamp") {
    if (skipGit || !baseRef) {
      console.error("plumb stamp: needs git + a --base ref to compute the diff");
      return 1;
    }
    let receiptObj: Record<string, unknown>;
    try {
      receiptObj = JSON.parse(rawReceipt);
    } catch (e) {
      console.error(`plumb stamp: receipt is not valid JSON: ${String(e)}`);
      return 1;
    }
    let diffSha: string;
    let changed: string[];
    let baseSha: string | undefined;
    try {
      // Pin the base (merge-base) so the diff hash is deterministic at gate time.
      baseSha = gitMergeBase(baseRef, cwd) ?? undefined;
      diffSha = computeDiffSha256(
        baseSha ? gitDiffExcludingReceiptFrom(baseSha, cwd) : gitDiffExcludingReceipt(baseRef, cwd),
      );
      changed = (baseSha ? gitChangedFilesFrom(baseSha, cwd) : gitChangedFiles(baseRef, cwd)).filter(
        (f) => !isReceiptPath(f),
      );
    } catch (e) {
      console.error(`plumb stamp: git failed: ${String(e)}`);
      return 1;
    }
    const prevSha = receiptObj.diff_sha256;
    if (baseSha) receiptObj.base_sha = baseSha;
    receiptObj.diff_sha256 = diffSha;
    receiptObj.changed_files = changed;
    writeFileSync(receiptPath, `${JSON.stringify(receiptObj, null, 2)}\n`);
    console.error(`stamped ${receiptPath} (base ${baseRef}${baseSha ? `, pinned @ ${baseSha.slice(0, 12)}…` : ""}):`);
    console.error(
      `  diff_sha256:   ${diffSha}${prevSha && prevSha !== diffSha ? `  (was ${String(prevSha)})` : ""}`,
    );
    if (baseSha) console.error(`  base_sha:      ${baseSha}`);
    console.error(`  changed_files (${changed.length}): ${changed.join(", ") || "(none)"}`);
    return 0;
  }

  // --- check: local pre-flight (#4, #39) ---
  // DEFAULT (no --review): runs the shape floor + diff_sha256 in the working
  // tree ONLY — the LLM semantic review does NOT run locally (it needs a key,
  // costs tokens, adds latency). So the default check must NEVER print a bare
  // APPROVE/REVIEW/REWORK verdict — that reads as the final gate verdict when
  // only the shape dimension was actually checked. It prints a scoped
  // "shape pre-flight" banner and says the semantic review still runs in CI.
  //
  // WITH --review: also runs the semantic review locally (same shared code path
  // as `plumb run`), so it prints the real verdict — full parity with CI. If no
  // provider key is available it degrades to the shape-only pre-flight with an
  // explicit note (never silently claims a verdict it didn't compute).
  const wantReview = flag("review");
  if (cmd === "check") {
    if (!skipGit) preflightWarnings(cwd, baseRef);
    const { result: shape } = shapeCheck(rawReceipt, policy, {
      baseRef: skipGit ? undefined : baseRef,
      cwd,
      skipGit,
    });

    // Can we run the full review locally? Only if --review AND a provider key
    // resolves. Probe here so a missing key degrades cleanly to shape-only.
    let canReviewLocally = false;
    if (wantReview) {
      try {
        selectProvider(policy);
        canReviewLocally = true;
      } catch (e) {
        console.error(`plumb check --review: ${(e as Error).message}`);
        console.error(
          "Falling back to shape-only pre-flight — set ANTHROPIC_API_KEY (or PLUMBLINE_API_KEY) to run the semantic review locally.",
        );
        if (policy.require_semantic_review) {
          console.error(
            "NOTE: require_semantic_review is true — CI (`plumb run`) will FAIL CLOSED (verdict: review) without a provider, not pass on shape alone. This local pre-flight is a convenience only.",
          );
        }
      }
    }

    if (!wantReview || !canReviewLocally) {
      // Shape-only pre-flight: assert ONLY the dimension we actually ran.
      for (const e of shape.errors) console.error(`shape ❌ ${e}`);
      for (const w of shape.warnings) console.error(`shape ⚠️  ${w}`);
      console.log(renderPreflight(shape));
      console.error(
        shape.pass
          ? "✓ shape pre-flight PASS — shape + diff_sha256 OK. This is NOT the full verdict: the LLM semantic review runs in CI. Run `plumb check --review` to get the full verdict locally."
          : "✗ shape pre-flight FAIL — fix the above before pushing. Tip: `plumb receipt --write` fixes diff_sha256/changed_files.",
      );
      return shape.pass ? 0 : 1;
    }
    // --review with a provider available → fall through to the shared
    // shape+semantic path below (single code path — never a parallel copy).
  }

  // --- Shape gate (always runs) ---
  const { result: shape, receipt } = shapeCheck(rawReceipt, policy, {
    baseRef: skipGit ? undefined : baseRef,
    cwd,
    skipGit,
  });

  for (const e of shape.errors) console.error(`shape ❌ ${e}`);
  for (const w of shape.warnings) console.error(`shape ⚠️  ${w}`);
  console.error(`shape gate: ${shape.pass ? "PASS" : "FAIL"}`);

  const gate: GateResult = {
    shape,
    final: shape.pass ? "approve" : "rework",
    reasons: [],
  };

  if (cmd === "shape") return shape.pass ? 0 : 1;

  // v0.6.1: set when a GitHub API call the gate NEEDS fails transiently and
  // survives every retry — the gate could not evaluate. Promotes the terminal
  // outcome to INDETERMINATE (infra_error), distinct from REWORK/REVIEW/PASS.
  let infraError: InfraError | undefined;

  // --- CI evidence integrity (run mode): corroborate against the real CI run (#6) ---
  // Don't trust the receipt's self-reported execution_evidence for these — read
  // the actual check-run conclusions for the PR head and require success. The
  // agent need not self-report status for these; CI is the source of truth.
  const ciEvidenceSeverity = resolveSeverity("ci_evidence", policy);
  if (cmd === "run" && !runCiEvidence && policy.ci_evidence_checks.length > 0) {
    // Phase 1 (quality): tests haven't run yet, so DON'T require ci-evidence.
    // Deferred to phase 2 (verify). Recorded so the verdict can't be mistaken
    // for "tests passed".
    console.error(
      `ci-evidence: SKIPPED in --phase quality — tests run in phase 2 (verify). ` +
        `This phase judges shape + semantic only.`,
    );
    gate.reasons.push(
      "⏭️ ci-evidence NOT checked in this phase (quality) — tests were SKIPPED and are verified in phase 2 (verify).",
    );
  } else if (cmd === "run" && policy.ci_evidence_checks.length > 0 && ciEvidenceSeverity === "off") {
    console.error(`ci-evidence: severity "off" in policy — verification skipped`);
    gate.reasons.push("CI evidence check is off in policy — not verified.");
  } else if (cmd === "run" && policy.ci_evidence_checks.length > 0) {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    // At "warn" severity a failure surfaces in the comment but doesn't gate.
    const fail = (msg: string): void => {
      console.error(`ci-evidence ❌ ${msg}`);
      if (ciEvidenceSeverity === "error") {
        shape.errors.push(msg);
        shape.pass = false;
        gate.final = "rework";
      } else {
        shape.warnings.push(`[ci_evidence: warn] ${msg}`);
      }
    };
    if (ci.provider === "github" && repo && token && ci.prNumber !== undefined) {
      try {
        const ev = await verifyCiEvidence(repo, ci.prNumber, token, policy.ci_evidence_checks);
        for (const n of ev.notes) console.error(`ci-evidence ✓ ${n}`);
        for (const e of ev.errors) fail(e);
        console.error(
          `ci-evidence gate: ${ev.pass ? "PASS" : ciEvidenceSeverity === "error" ? "FAIL" : "FAIL (warn — not gating)"}`,
        );
        if (ev.pass) {
          gate.reasons.push(
            `CI evidence corroborated against the real run (${ev.notes.join(", ")}) — not self-reported.`,
          );
        }
      } catch (e) {
        if (e instanceof InfraError) {
          // v0.6.1: the GitHub API call failed transiently (5xx/429/timeout)
          // and survived every retry — we COULD NOT EVALUATE. This is the exact
          // 2026-07-16 incident: a 503 must NOT become a REWORK ("agent's turn
          // to fix code"). Route to the distinct INDETERMINATE outcome and stop
          // — no code verdict is possible on this run.
          console.error(`ci-evidence: INDETERMINATE — could not evaluate: ${e.message}`);
          infraError = e;
        } else {
          // A REAL error (auth/permission/malformed response) still routes to
          // the normal severity handling (REWORK at "error" severity).
          fail(`ci-evidence: could not verify CI checks: ${String(e)}`);
        }
      }
    } else {
      console.error("ci-evidence: configured but no GitHub PR context/token — skipped");
      gate.reasons.push("CI evidence configured but no GitHub PR context — not verified.");
    }
  }

  // --- Semantic review ---
  if (infraError) {
    // A GitHub call the gate needs failed transiently and survived every retry.
    // We could NOT evaluate — do not run (or report) a semantic review, and do
    // NOT emit a code verdict. Promote to INDETERMINATE (infra_error).
    gate.final = "indeterminate";
    gate.reasons.push(
      `⚠️ Gate could not evaluate — GitHub infrastructure error (${infraError.message}). ` +
        "This is NOT a code verdict (neither a REWORK nor an approval). Re-run the gate when GitHub recovers.",
    );
  } else if (!shape.pass || !receipt) {
    gate.final = "rework";
    gate.reasons.push("semantic review skipped: shape gate failed — fix shape errors first");
  } else {
    const missionPath = resolveDualPath(cwd, arg("mission", policy.mission_file)!);
    if (!existsSync(missionPath)) {
      console.error(`plumb: mission file not found at ${missionPath}`);
      return 1;
    }
    const mission = readFileSync(missionPath, "utf8");
    const diff = skipGit ? "" : getDiff(baseRef, cwd);

    // Cost control (#26): skip the LLM for low-risk diffs — but NEVER for
    // self_modifying / protected-path changes (hard floor). Opt-in; default
    // config skips nothing.
    const skip = shouldSkipReview(receipt, policy, diff);
    // Redundant hard floor, defense-in-depth: a bug in shouldSkipReview must
    // NEVER let a self_modifying / protected-path change auto-approve on the
    // skip path. Recompute the floor here from the receipt + the ACTUAL diff's
    // changed files (not just the receipt's self-report) and refuse to skip.
    const floorHit = protectedFloorHit(receipt, policy, baseRef, cwd, skipGit);
    if (skip.skip && floorHit) {
      console.error(
        `semantic review: skip DENIED by protected floor (${floorHit}) — a self_modifying/protected ` +
          `change never skips review, regardless of skip_review config.`,
      );
      gate.reasons.push(`Semantic review floor: ${floorHit} — skip denied, review enforced.`);
    }
    if (skip.skip && !floorHit) {
      console.error(`semantic review: SKIPPED (${skip.reason}) — shape gate stands as the verdict`);
      gate.reasons.push(`Semantic review skipped: ${skip.reason} (shape gate passed).`);
      // Shape passed and review was intentionally skipped → approve on shape.
      gate.final = "approve";
    } else {
      if (skip.reason) {
        // A "never skipped" floor reason worth surfacing for auditability.
        gate.reasons.push(`Semantic review enforced: ${skip.reason}.`);
      }

      const model = resolveReviewModel(policy);

      // Cost control (#26): reuse a cached verdict for an identical diff.
      // The provider is CONSTRUCTED here (needs a key + valid config). When it
      // can't be — no key, misconfig — the review is UNAVAILABLE.
      const provider = (() => {
        try {
          return selectProvider(policy);
        } catch (e) {
          console.error(`plumb: ${(e as Error).message}`);
          return null;
        }
      })();

      let review: Awaited<ReturnType<typeof semanticReview>> | null = null;

      // FAIL CLOSED: the review is required but the provider can't be
      // constructed (no key / misconfig). A proof-carrying gate does not pass on
      // the deterministic shape half alone when a required semantic judgment
      // never happened. `require_semantic_review` defaults to true; an explicit
      // `false` is the offline/self-hosted opt-out → shape-only pass with a
      // LOUD "review did NOT run" note (never a silent shape-only pass).
      if (!provider) {
        const reason =
          "the review provider could not be constructed (no API key or misconfigured provider)";
        review = resolveUnavailableVerdict(policy, reason, shape.pass);
        if (policy.require_semantic_review) {
          console.error(
            `semantic review: REQUIRED but unavailable — FAILING CLOSED. ${reason}. ` +
              `Set ANTHROPIC_API_KEY / PLUMBLINE_API_KEY, or set require_semantic_review:false in policy to allow a shape-only pass.`,
          );
          gate.reasons.push("Semantic review required but unavailable — failing closed (verdict: review).");
        } else {
          console.error(
            `semantic review: unavailable and require_semantic_review is false — ` +
              `shape-only pass with a LOUD note (review did NOT run). ${reason}.`,
          );
          gate.reasons.push(
            "⚠️ Semantic review did NOT run (require_semantic_review:false + provider unavailable) — verdict rests on the shape gate alone.",
          );
        }
        gate.review = review;
        gate.final = review.verdict as Verdict;
      }

      const cacheDir = join(cwd, policy.review_cache.dir);

      // Cache validation: only trust the cache key when receipt.diff_sha256
      // actually matches the current diff. The shape gate's diff_integrity check
      // normally guarantees this, but it's downgradable via check_severity — so
      // recompute independently here. A mismatch → treat as a cache MISS (run a
      // live review) rather than serve a verdict keyed on a stale/wrong hash.
      let cacheKeyValid = false;
      if (provider && policy.review_cache.enabled && !skipGit && receipt.diff_sha256) {
        try {
          // Recompute against the receipt's pinned base_sha when present (the
          // deterministic path the shape gate used), else the live 3-dot.
          const actualSha = computeDiffSha256(
            receipt.base_sha
              ? gitDiffExcludingReceiptFrom(receipt.base_sha, cwd)
              : gitDiffExcludingReceipt(baseRef, cwd),
          );
          cacheKeyValid = actualSha === receipt.diff_sha256;
          if (!cacheKeyValid) {
            console.error(
              `semantic review: cache lookup SKIPPED — receipt.diff_sha256 ` +
                `(${receipt.diff_sha256.slice(0, 12)}…) != actual diff (${actualSha.slice(0, 12)}…); ` +
                `running a live review to avoid serving a mismatched cached verdict.`,
            );
          }
        } catch {
          // Can't recompute the hash → don't trust the cache; run live.
          cacheKeyValid = false;
        }
      }

      if (provider && cacheKeyValid) {
        const hit = readReviewCache(
          cacheDir,
          receipt.diff_sha256!,
          provider.id,
          model,
          PROMPT_VERSION,
        );
        if (hit) {
          review = { ...hit, audit: { ...hit.audit, cached: true } };
          console.error(
            `semantic review: CACHE HIT for diff ${receipt.diff_sha256.slice(0, 12)}… (${provider.id}/${model}) — no LLM call`,
          );
          gate.reasons.push(`Reused cached verdict for this diff (diff_sha256, ${provider.id}/${model}).`);
        }
      }

      if (provider && !review) {
        // Re-review context (#41, Change 3): on a re-push, feed the prior
        // capsule + fix commits so the review is convergent (verify prior
        // items, review only new hunks) and the round cap is enforced. Read
        // from the durable gate comment; best-effort — never fail on this.
        let reviewContext: import("./types.js").ReviewContext | undefined;
        if (cmd === "run") {
          const repo = process.env.GITHUB_REPOSITORY;
          const token = process.env.GITHUB_TOKEN;
          if (ci.provider === "github" && repo && token && ci.prNumber !== undefined) {
            const existing = await fetchExistingGateComment(repo, ci.prNumber, token);
            if (existing) {
              const round = countRounds(existing);
              reviewContext = {
                round,
                priorCapsule: extractPriorCapsule(existing),
                fixCommits: skipGit ? undefined : fixCommitsSince(baseRef, cwd),
              };
              gate.reasons.push(
                `Re-review round ${round} — convergent delta review against the prior capsule.`,
              );
            }
          }
        }
        // FAIL CLOSED on a runtime provider failure too. The provider was
        // constructed (a key is present) but the call itself can still fail —
        // API error (5xx/429/auth), a network/DNS error, or a timeout. That is
        // ALSO a review that did not complete, so it must not silently fall
        // through to a shape-only pass: same require_semantic_review contract.
        try {
          review = await semanticReview(mission, receipt, diff, policy, provider, reviewContext);
        } catch (e) {
          const reason = `the review provider call failed (${(e as Error).message})`;
          review = resolveUnavailableVerdict(policy, reason, shape.pass);
          if (policy.require_semantic_review) {
            console.error(
              `semantic review: REQUIRED but the provider call FAILED — FAILING CLOSED. ${reason}.`,
            );
            gate.reasons.push(
              "Semantic review required but the provider call failed — failing closed (verdict: review).",
            );
          } else {
            console.error(
              `semantic review: provider call failed and require_semantic_review is false — ` +
                `shape-only pass with a LOUD note (review did NOT run). ${reason}.`,
            );
            gate.reasons.push(
              "⚠️ Semantic review did NOT run (require_semantic_review:false + provider call failed) — verdict rests on the shape gate alone.",
            );
          }
        }
        // Only persist a REAL, provider-produced verdict under a key we verified
        // matches the actual diff — never cache a fail-closed/unavailable verdict
        // (audit is undefined on those), and never under a stale/wrong sha.
        if (
          review.audit &&
          policy.review_cache.enabled &&
          !skipGit &&
          receipt.diff_sha256 &&
          cacheKeyValid
        ) {
          writeReviewCache(
            cacheDir,
            receipt.diff_sha256,
            provider.id,
            model,
            PROMPT_VERSION,
            review,
          );
        }
      }

      // review is always set by now: a cache hit, a live verdict, or a
      // fail-closed/opt-out verdict from an unavailable provider.
      gate.review = review!;
      gate.final = review!.verdict as Verdict;

      // Budget: soft per-PR spend cap is informational — surface it for audit.
      if (policy.budget.max_usd_per_pr > 0) {
        gate.reasons.push(
          `Budget cap configured: max $${policy.budget.max_usd_per_pr}/PR (model ${model}).`,
        );
      }

      console.error(
        `semantic review: ${review!.verdict} (confidence ${review!.confidence}) [${review!.audit?.provider ?? "unavailable"}/${model}, temp ${review!.audit?.temperature}, prompt ${review!.audit?.prompt_version}${review!.audit?.cached ? ", cached" : ""}]`,
      );
      console.error(`  coverage: ${review!.validation_coverage_notes}`);
      console.error(`  mission:  ${review!.mission_alignment_notes}`);
      console.error(`  risk:     ${review!.risk_notes}`);
    }
  }

  // --- Phased-gate verdict framing (#58) ---
  // Make WHICH phase produced the verdict unmistakable in the receipt/comment,
  // and — critically — make a phase-1 REWORK read as "fast checks failed, tests
  // were SKIPPED, agent-fixable" so nobody mistakes a clean phase-1 for
  // "tests passed". The verdict SURFACES (REWORK/REVIEW/PASS) are unchanged
  // (v0.5.0 #56); this only annotates the phase provenance.
  if (cmd === "run" && phase !== "full" && gate.final !== "indeterminate") {
    if (phase === "quality") {
      if (gate.final === "rework") {
        gate.reasons.push(
          "🔁 Phase 1 (quality) REWORK — fast checks (shape/semantic) failed and the test suite was " +
            "SKIPPED (not yet run). These are agent-fixable: fix the 🤖 items and re-push; the cheap " +
            "phase re-runs in ~2 min. Do NOT read this as 'tests passed' — tests only run in phase 2 (verify).",
        );
      } else if (gate.final === "review") {
        // REVIEW is a TERMINAL verdict only (produced in verify/full, AFTER
        // ci-evidence). Phase 1's sole blocking job is REWORK detection, so a
        // "review" outcome here (a protected-surface change / a blocking+human
        // finding / a low-confidence downgrade — none of which are rework) is
        // NOT a phase-1 failure: it must NOT block the test jobs and must NOT
        // publish a REVIEW check-run. If it did, phase 2's `needs:` chain would
        // SKIP the tests → phase 3's ci-evidence would then see conclusion
        // `skipped` → a contradictory REWORK. That double verdict (REVIEW +
        // REWORK on one PR) was the 2026-07-17 incident. Remap to a non-blocking
        // pass so the tests run; verify re-derives REVIEW terminally.
        gate.final = "approve";
        gate.reasons.push(
          "✅ Phase 1 (quality) PASSED (no rework) — shape + semantic review found nothing the agent must " +
            "fix. Human sign-off looks likely (a protected surface or a human-actor finding), but REVIEW is a " +
            "TERMINAL verdict emitted only by phase 2 (verify), AFTER the tests run. Phase 1 blocks ONLY on " +
            "REWORK, so this passes and lets the tests proceed — it is NOT a terminal PASS.",
        );
      } else {
        gate.reasons.push(
          "✅ Phase 1 (quality) PASSED — shape + semantic review are clean. " +
            "This is NOT a terminal PASS: tests were NOT run in this phase. " +
            "Phase 2 (verify) runs the full test suite + ci-evidence and emits the terminal verdict.",
        );
      }
    } else if (phase === "verify") {
      gate.reasons.push(
        "Phase 2 (verify): terminal verdict — ci-evidence (tests present + passing) verified against the " +
          "real CI run. Phase 1 (quality: shape + semantic) is assumed already green.",
      );
    }
  }

  // --- CI reporting ---
  if (cmd === "run") {
    // PROOFGATE_PR_NUMBER is a legacy alias (proofgate→Plumbline rename), retained for back-compat.
    const prOverride = process.env.PLUMBLINE_PR_NUMBER || process.env.PROOFGATE_PR_NUMBER;
    if (ci.prNumber !== undefined && prOverride) {
      ci.prNumber = Number(prOverride);
    }

    // Optional-but-good findings → tracked follow-up issue(s). File them BEFORE
    // posting the comment so the reasons line can report what was filed.
    // v0.7.0 flood fix: (1) THRESHOLD — only file when the review's confidence
    // clears policy.follow_ups.min_confidence; below the bar the findings stay
    // in the PR comment (already rendered) and are NOT filed as tickets, so nits
    // never become issues. (2) CONSOLIDATE — a SINGLE "Follow-ups for #<PR>"
    // issue with a checklist, updated in place on re-runs (deduped by PR),
    // instead of N separate issues. Best-effort; never blocks the gate.
    const followUps = gate.review?.failure_capsule?.follow_ups ?? [];
    const followUpConfidence = gate.review?.confidence ?? 0;
    const meetsBar = followUpConfidence >= policy.follow_ups.min_confidence;
    if (ci.provider === "github" && followUps.length > 0 && !meetsBar) {
      gate.reasons.push(
        `${followUps.length} optional follow-up finding(s) below the filing bar ` +
          `(confidence ${followUpConfidence} < ${policy.follow_ups.min_confidence}) — shown in the PR comment, not filed as issues.`,
      );
      console.error(
        `follow-ups: ${followUps.length} finding(s) below min_confidence ${policy.follow_ups.min_confidence} — not filed (kept in PR comment).`,
      );
    } else if (ci.provider === "github" && followUps.length > 0) {
      const repo = process.env.GITHUB_REPOSITORY;
      const token = process.env.GITHUB_TOKEN;
      if (repo && token && ci.prNumber !== undefined) {
        try {
          if (policy.follow_ups.consolidate) {
            const res = await fileConsolidatedFollowUps(repo, ci.prNumber, followUps, token);
            if (res.action === "created" && res.number !== null) {
              gate.reasons.push(
                `Filed one consolidated follow-up issue #${res.number} with ${followUps.length} material finding(s).`,
              );
              console.error(`filed consolidated follow-up issue #${res.number} (${followUps.length} items)`);
            } else if (res.action === "updated" && res.number !== null) {
              gate.reasons.push(
                `Updated the consolidated follow-up issue #${res.number} in place (${followUps.length} material finding(s)).`,
              );
              console.error(`updated consolidated follow-up issue #${res.number} in place`);
            }
          } else {
            const created = await fileFollowUps(repo, ci.prNumber, followUps, token);
            if (created.length > 0) {
              gate.reasons.push(
                `Filed ${created.length} optional follow-up issue(s): ${created.map((n) => `#${n}`).join(", ")}.`,
              );
              console.error(`filed ${created.length} follow-up issue(s): ${created.map((n) => `#${n}`).join(", ")}`);
            } else {
              gate.reasons.push(`${followUps.length} optional follow-up finding(s) already tracked.`);
            }
          }
        } catch (e) {
          console.error(`plumbline: could not file follow-up issues: ${(e as Error).message}`);
        }
      }
    }

    const posted = await reportToCi(
      ci,
      renderComment(gate),
      gate.final === "approve",
      renderCiSummary(gate),
    ).catch((e) => {
      console.error(`plumb: failed to post CI comment: ${e?.message ?? e}`);
      return false;
    });
    if (posted) {
      console.error(`posted gate result to PR #${ci.prNumber} (${ci.provider})`);
    } else {
      console.error("plumb: no PR context detected — printing comment:\n");
      console.log(renderComment(gate));
    }

    // Publish the DISTINCT per-verdict check-run (#54). This is what makes
    // REWORK vs REVIEW unmistakable in the GitHub Checks list: a per-verdict
    // NAME + CONCLUSION (rework→failure, review→action_required, approve→
    // success), so the two non-pass states never read as the same red X.
    // Best-effort and GitHub-only: needs the head SHA + a checks:write token.
    if (ci.provider === "github") {
      const repo = process.env.GITHUB_REPOSITORY;
      const token = process.env.GITHUB_TOKEN;
      if (repo && token && ci.prNumber !== undefined) {
        const pres = verdictPresentation(gate.final);
        try {
          const headSha = await getPrHeadSha(repo, ci.prNumber, token);
          const ok = await publishCheckRun(
            repo,
            headSha,
            pres.checkName,
            pres.conclusion,
            pres.commentTitle,
            renderCiSummary(gate).message,
            token,
          );
          if (ok) {
            console.error(
              `published verdict check-run "${pres.checkName}" (conclusion: ${pres.conclusion})`,
            );
          }
        } catch (e) {
          console.error(`plumbline: could not publish verdict check-run: ${(e as Error).message}`);
        }
      }
    }

    // --- Lifecycle: auto_merge on a TERMINAL PASS (v0.7.0) ---
    // In lifecycle "auto_merge" a terminal PASS hands the merge to GitHub: we
    // enable the PR's NATIVE auto-merge so GitHub merges it once every required
    // check is green. Plumbline judges; GitHub merges (no custom merge loop).
    // Gates: (1) lifecycle must be auto_merge; (2) verdict must be a TERMINAL
    // PASS — never REVIEW/REWORK, and never a phase-1 (quality) remapped pass
    // (which is explicitly "NOT a terminal PASS"); (3) GitHub PR context + token.
    const terminalPhase = phase === "full" || phase === "verify";
    if (
      ci.provider === "github" &&
      policy.lifecycle === "auto_merge" &&
      gate.final === "approve" &&
      terminalPhase
    ) {
      const repo = process.env.GITHUB_REPOSITORY;
      const token = process.env.GITHUB_TOKEN;
      if (repo && token && ci.prNumber !== undefined) {
        const enabled = await enableAutoMerge(repo, ci.prNumber, token);
        if (enabled) {
          gate.reasons.push(
            `lifecycle:auto_merge — enabled GitHub-native auto-merge on PR #${ci.prNumber}. ` +
              `GitHub will merge once all required checks are green.`,
          );
          console.error(`lifecycle:auto_merge — enabled GitHub auto-merge on PR #${ci.prNumber}`);
        }
      }
    } else if (
      policy.lifecycle === "auto_merge" &&
      gate.final !== "approve" &&
      ci.provider === "github"
    ) {
      console.error(
        `lifecycle:auto_merge — verdict is ${gate.final} (not a terminal PASS); auto-merge NOT enabled.`,
      );
    }
  } else if (cmd === "check") {
    // `check --review`: full local parity (shape + semantic) — print the REAL
    // verdict, since we actually ran the review. CI still re-runs on merge and
    // remains authoritative (freshest diff, CI-evidence corroboration).
    console.log(renderComment(gate));
    console.error(
      "\n✓ local full review complete (shape + semantic) — verdict above. CI re-runs this on the PR and remains authoritative on merge.",
    );
  } else {
    console.log(JSON.stringify(gate, null, 2));
  }

  // Exit code drives required-check status: only approve passes.
  return gate.final === "approve" ? 0 : 1;
}

// Run as a CLI only when invoked directly (not when imported by a test that
// wants a pure export like uncommittedReceipts). `import.meta.url` matches the
// process entry path exactly when this file is the executed script.
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`plumb: ${err?.message ?? err}`);
      process.exit(1);
    },
  );
}
