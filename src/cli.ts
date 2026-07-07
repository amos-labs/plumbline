#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { PolicySchema, type GateResult, type Policy, type Receipt, type Verdict } from "./types.js";
import {
  shapeCheck,
  computeDiffSha256,
  gitDiffExcludingReceipt,
  gitChangedFiles,
  isReceiptPath,
} from "./shape.js";
import { semanticReview, resolveReviewModel, PROMPT_VERSION } from "./review.js";
import { selectProvider } from "./provider.js";
import { shouldSkipReview, readReviewCache, writeReviewCache, protectedFloor } from "./cost.js";
import { renderComment, renderCiSummary, verifyCiEvidence } from "./github.js";
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
function resolveReceiptPath(
  explicit: string,
  baseRef: string | undefined,
  cwd: string,
  skipGit: boolean,
  fallback: string,
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
    cmd === "setup-protection" || cmd === "migration-guard"
      ? DEFAULT_RECEIPT
      : resolveReceiptPath(
          receiptIsDefault ? DEFAULT_RECEIPT : receiptArg,
          skipGit ? undefined : baseRef,
          cwd,
          skipGit,
          DEFAULT_RECEIPT,
        );

  if (!cmd || !["init", "new", "schema", "shape", "review", "run", "stamp", "check", "receipt", "propose", "archive", "setup-protection", "migration-guard"].includes(cmd)) {
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
  plumb schema  (print the receipt field reference — every field + allowed enum values)
  plumb stamp   [--receipt path] [--base ref]   (fill diff_sha256 + changed_files from the real diff)
  plumb check   [--receipt path] [--policy path] [--base ref]   (local pre-flight: shape + diff_sha256, prints the capsule)
  plumb shape   [--receipt path] [--policy path] [--base ref] [--no-git]
  plumb review  [--receipt path] [--policy path] [--base ref] [--mission path]
  plumb run     [--receipt path] [--policy path] [--base ref]   (shape + review + PR comment in CI)
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
    const agentId = arg("agent", process.env.PLUMBLINE_AGENT_ID || process.env.PROOFGATE_AGENT_ID || "agent")!;
    let diffSha: string | undefined;
    let changed: string[] | undefined;
    if (!skipGit && baseRef) {
      try {
        diffSha = computeDiffSha256(gitDiffExcludingReceipt(baseRef, cwd));
        changed = gitChangedFiles(baseRef, cwd).filter((f) => !isReceiptPath(f));
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
    const receipt = newReceipt({ taskId, agentId, diffSha256: diffSha, changedFiles: changed });
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
    const write = flag("write");
    const checkOnly = flag("check");
    if (write === checkOnly) {
      console.error("plumb receipt: pass exactly one of --write | --check");
      return 2;
    }
    if (skipGit || !baseRef) {
      console.error("plumb receipt: needs git + a base ref to compute the diff");
      return 1;
    }
    let mech: MechanicalFields;
    try {
      const changed = gitChangedFiles(baseRef, cwd).filter((f) => !isReceiptPath(f));
      mech = {
        diffSha256: computeDiffSha256(gitDiffExcludingReceipt(baseRef, cwd)),
        changedFiles: changed,
        hits: protectedHits(changed, policy.protected_paths),
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
      const agentId = arg("agent", process.env.PLUMBLINE_AGENT_ID || process.env.PROOFGATE_AGENT_ID || "agent")!;
      const receipt = newReceipt({
        taskId,
        agentId,
        diffSha256: mech.diffSha256,
        changedFiles: mech.changedFiles,
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
    try {
      diffSha = computeDiffSha256(gitDiffExcludingReceipt(baseRef, cwd));
      changed = gitChangedFiles(baseRef, cwd).filter((f) => !isReceiptPath(f));
    } catch (e) {
      console.error(`plumb stamp: git failed: ${String(e)}`);
      return 1;
    }
    const prevSha = receiptObj.diff_sha256;
    receiptObj.diff_sha256 = diffSha;
    receiptObj.changed_files = changed;
    writeFileSync(receiptPath, `${JSON.stringify(receiptObj, null, 2)}\n`);
    console.error(`stamped ${receiptPath} (base ${baseRef}):`);
    console.error(
      `  diff_sha256:   ${diffSha}${prevSha && prevSha !== diffSha ? `  (was ${String(prevSha)})` : ""}`,
    );
    console.error(`  changed_files (${changed.length}): ${changed.join(", ") || "(none)"}`);
    return 0;
  }

  // --- check: local pre-flight — shape + diff_sha256, render the would-be capsule (#4) ---
  // Same shape + diff integrity the action runs in CI, but in the working tree —
  // so a shape/sha error is caught before pushing (no red CI round-trip, no
  // wasted Actions minutes). Semantic review still runs server-side in CI.
  if (cmd === "check") {
    if (!skipGit) preflightWarnings(cwd, baseRef);
    const { result: shape } = shapeCheck(rawReceipt, policy, {
      baseRef: skipGit ? undefined : baseRef,
      cwd,
      skipGit,
    });
    const gate: GateResult = {
      shape,
      final: shape.pass ? "approve" : "rework",
      reasons: [],
    };
    // Print the same capsule CI would post, so the author sees exactly what the
    // gate will say.
    console.log(renderComment(gate));
    for (const e of shape.errors) console.error(`shape ❌ ${e}`);
    for (const w of shape.warnings) console.error(`shape ⚠️  ${w}`);
    console.error(
      shape.pass
        ? "✓ pre-flight PASS — shape + diff_sha256 OK. Safe to push (semantic review still runs in CI)."
        : "✗ pre-flight FAIL — fix the above before pushing. Tip: `plumb receipt --write` fixes diff_sha256/changed_files.",
    );
    return shape.pass ? 0 : 1;
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

  // --- CI evidence integrity (run mode): corroborate against the real CI run (#6) ---
  // Don't trust the receipt's self-reported execution_evidence for these — read
  // the actual check-run conclusions for the PR head and require success. The
  // agent need not self-report status for these; CI is the source of truth.
  const ciEvidenceSeverity = resolveSeverity("ci_evidence", policy);
  if (cmd === "run" && policy.ci_evidence_checks.length > 0 && ciEvidenceSeverity === "off") {
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
        fail(`ci-evidence: could not verify CI checks: ${String(e)}`);
      }
    } else {
      console.error("ci-evidence: configured but no GitHub PR context/token — skipped");
      gate.reasons.push("CI evidence configured but no GitHub PR context — not verified.");
    }
  }

  // --- Semantic review ---
  if (!shape.pass || !receipt) {
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

      // Cost control (#26): reuse a cached verdict for an identical diff.
      const provider = (() => {
        try {
          return selectProvider(policy);
        } catch (e) {
          console.error(`plumb: ${(e as Error).message}`);
          return null;
        }
      })();
      if (!provider) return 1;

      const cacheDir = join(cwd, policy.review_cache.dir);
      const model = resolveReviewModel(policy);
      let review: Awaited<ReturnType<typeof semanticReview>> | null = null;

      // Cache validation: only trust the cache key when receipt.diff_sha256
      // actually matches the current diff. The shape gate's diff_integrity check
      // normally guarantees this, but it's downgradable via check_severity — so
      // recompute independently here. A mismatch → treat as a cache MISS (run a
      // live review) rather than serve a verdict keyed on a stale/wrong hash.
      let cacheKeyValid = false;
      if (policy.review_cache.enabled && !skipGit && receipt.diff_sha256) {
        try {
          const actualSha = computeDiffSha256(gitDiffExcludingReceipt(baseRef, cwd));
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

      if (cacheKeyValid) {
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

      if (!review) {
        review = await semanticReview(mission, receipt, diff, policy, provider);
        // Only persist under a key we verified matches the actual diff — never
        // write a verdict under a stale/wrong diff_sha256.
        if (policy.review_cache.enabled && !skipGit && receipt.diff_sha256 && cacheKeyValid) {
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

      gate.review = review;
      gate.final = review.verdict as Verdict;

      // Budget: soft per-PR spend cap is informational — surface it for audit.
      if (policy.budget.max_usd_per_pr > 0) {
        gate.reasons.push(
          `Budget cap configured: max $${policy.budget.max_usd_per_pr}/PR (model ${model}).`,
        );
      }

      console.error(
        `semantic review: ${review.verdict} (confidence ${review.confidence}) [${review.audit?.provider}/${model}, temp ${review.audit?.temperature}, prompt ${review.audit?.prompt_version}${review.audit?.cached ? ", cached" : ""}]`,
      );
      console.error(`  coverage: ${review.validation_coverage_notes}`);
      console.error(`  mission:  ${review.mission_alignment_notes}`);
      console.error(`  risk:     ${review.risk_notes}`);
    }
  }

  // --- CI reporting ---
  if (cmd === "run") {
    const prOverride = process.env.PLUMBLINE_PR_NUMBER || process.env.PROOFGATE_PR_NUMBER;
    if (ci.prNumber !== undefined && prOverride) {
      ci.prNumber = Number(prOverride);
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
  } else {
    console.log(JSON.stringify(gate, null, 2));
  }

  // Exit code drives required-check status: only approve passes.
  return gate.final === "approve" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`plumb: ${err?.message ?? err}`);
    process.exit(1);
  },
);
