#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { PolicySchema, type GateResult, type Policy, type Verdict } from "./types.js";
import {
  shapeCheck,
  computeDiffSha256,
  gitDiffExcludingReceipt,
  gitChangedFiles,
  isReceiptPath,
} from "./shape.js";
import { semanticReview } from "./review.js";
import { renderComment, renderCiSummary, verifyCiEvidence } from "./github.js";
import { detectCi, reportToCi } from "./ci.js";
import { pickReceipt, type ReceiptCandidate } from "./receipt-select.js";
import { runInit, sanitizeTaskId, newReceipt, formatSchemaReference } from "./scaffold.js";
import { detectBaseRef } from "./base.js";
import {
  protectedHits,
  refreshMechanical,
  checkMechanical,
  JUDGMENT_CHECKLIST,
  type MechanicalFields,
} from "./receipt-write.js";
import { runPropose } from "./propose.js";

function loadPolicy(path: string): Policy {
  if (!existsSync(path)) {
    console.error(`proofgate: policy file not found at ${path} — using defaults`);
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
 * Pre-push hygiene warnings (non-fatal). The two traps an author hits locally:
 *  1. A shared `.proofgate/receipt.json` — the anti-pattern that drags the last
 *     receipt forward across branches and conflicts. Use one file per PR.
 *  2. Uncommitted changes — the gate binds the COMMITTED HEAD via the 3-dot
 *     `git diff <base>...HEAD`, so working-tree edits are NOT in diff_sha256.
 */
function preflightWarnings(cwd: string, baseRef: string): void {
  if (existsSync(join(cwd, ".proofgate", "receipt.json"))) {
    console.error(
      "proofgate ⚠️  legacy .proofgate/receipt.json present — use one file per PR at " +
        ".proofgate/receipts/<task_id>.json (a shared receipt.json gets dragged forward " +
        "across branches and conflicts). `proofgate new` creates the per-PR file.",
    );
  }
  try {
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim();
    if (dirty) {
      console.error(
        `proofgate ⚠️  uncommitted changes present. The gate binds the COMMITTED HEAD via ` +
          `\`git diff ${baseRef}...HEAD\` (3-dot) — uncommitted edits are NOT in diff_sha256. ` +
          `Commit, then re-run \`proofgate stamp\` so the hash matches what CI computes.`,
      );
    }
  } catch {
    /* not a git repo / git unavailable — skip */
  }
}

const DEFAULT_RECEIPT = ".proofgate/receipt.json";

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
): string {
  if (explicit !== DEFAULT_RECEIPT) return explicit;
  if (skipGit || !baseRef) return DEFAULT_RECEIPT;
  let changed: string[] = [];
  try {
    changed = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=AMR", `${baseRef}...HEAD`],
      { cwd, encoding: "utf8" },
    )
      .split("\n")
      .map((l) => l.trim())
      .filter((f) => /^\.proofgate\/receipts\/[^/]+\.json$/.test(f));
  } catch {
    return DEFAULT_RECEIPT;
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
  return DEFAULT_RECEIPT;
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
  const policyPath = arg("policy", ".proofgate/policy.json")!;
  const baseRef = arg("base", ci.baseRef ?? detectBaseRef(cwd))!;
  const skipGit = flag("no-git");
  // init/new don't operate on an existing receipt — skip resolution (and its
  // git call, which would print a spurious diff error in a fresh repo).
  const receiptPath =
    cmd === "init" || cmd === "new" || cmd === "schema" || cmd === "propose"
      ? DEFAULT_RECEIPT
      : resolveReceiptPath(arg("receipt", DEFAULT_RECEIPT)!, skipGit ? undefined : baseRef, cwd, skipGit);

  if (!cmd || !["init", "new", "schema", "shape", "review", "run", "stamp", "check", "receipt", "propose"].includes(cmd)) {
    console.log(`proofgate — proof-carrying gate for AI agent work

usage:
  proofgate init    (scaffold workflow + .proofgate/ + AGENTS.md into this repo — start here)
  proofgate propose "<title>" [--body text] [--repo owner/name] [--lite] [--task id]
                    (intake: open the GitHub issue + scaffold openspec/changes/<slug>/ born linked;
                     --lite = plain issue, no contract folder — for trivial work)
  proofgate new     [--task id] [--agent id] [--base ref]   (scaffold a fresh per-PR receipt, diff-stamped)
  proofgate receipt --write [--task id] [--agent id]   (one idempotent step: scaffold if absent, else refresh
                    the mechanical fields — diff_sha256, changed_files, self_modifying — judgment fields untouched)
  proofgate receipt --check   (mechanical staleness only; exit 1 if stale — pre-push-hook friendly)
  proofgate schema  (print the receipt field reference — every field + allowed enum values)
  proofgate stamp   [--receipt path] [--base ref]   (fill diff_sha256 + changed_files from the real diff)
  proofgate check   [--receipt path] [--policy path] [--base ref]   (local pre-flight: shape + diff_sha256, prints the capsule)
  proofgate shape   [--receipt path] [--policy path] [--base ref] [--no-git]
  proofgate review  [--receipt path] [--policy path] [--base ref] [--mission path]
  proofgate run     [--receipt path] [--policy path] [--base ref]   (shape + review + PR comment in CI)

receipt: auto-discovered from the PR diff at .proofgate/receipts/<task_id>.json
         (one file per PR — no conflicts); falls back to .proofgate/receipt.json.
         Pass --receipt to override.
policy default:  .proofgate/policy.json
env: ANTHROPIC_API_KEY (review), GITHUB_TOKEN + GITHUB_REPOSITORY + PR number (comment), PROOFGATE_MODEL (override)`);
    return cmd ? 2 : 0;
  }

  // --- schema: print the receipt field reference (no policy/receipt/git needed) ---
  if (cmd === "schema") {
    console.log(formatSchemaReference());
    return 0;
  }

  // --- init: scaffold the gate into this repo (no policy/receipt needed) ---
  if (cmd === "init") {
    for (const it of runInit(cwd)) {
      console.error(`  ${it.created ? "created" : "skip   "} ${it.dest}${it.note ? `  (${it.note})` : ""}`);
    }
    console.error(
      `\nproofgate initialized. Next:\n` +
        `  1. Read .proofgate/AGENTS.md (the agent guide)\n` +
        `  2. proofgate new  →  fill the receipt  →  proofgate stamp  →  proofgate check\n` +
        `  3. (human) make 'proofgate' a required check + add the ANTHROPIC_API_KEY secret — steps in AGENTS.md`,
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
      console.error(`proofgate propose: a title is required — proofgate propose "<the ask>" [--body text] [--repo owner/name] [--lite] [--task id]`);
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
          `then work → 'proofgate receipt --write'${res.issueNumber ? ` (task_id ${res.issueNumber} is already linked)` : ""}.`,
      );
    }
    return 0;
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
    const agentId = arg("agent", process.env.PROOFGATE_AGENT_ID || "agent")!;
    let diffSha: string | undefined;
    let changed: string[] | undefined;
    if (!skipGit && baseRef) {
      try {
        diffSha = computeDiffSha256(gitDiffExcludingReceipt(baseRef, cwd));
        changed = gitChangedFiles(baseRef, cwd).filter((f) => !isReceiptPath(f));
      } catch {
        /* leave placeholders; author runs `proofgate stamp` later */
      }
    }
    const dest = join(cwd, ".proofgate", "receipts", `${taskId}.json`);
    if (existsSync(dest)) {
      console.error(
        `proofgate new: .proofgate/receipts/${taskId}.json already exists — left as-is. ` +
          `Edit it, then run 'proofgate stamp' + 'proofgate check'.`,
      );
      return 0;
    }
    mkdirSync(dirname(dest), { recursive: true });
    const receipt = newReceipt({ taskId, agentId, diffSha256: diffSha, changedFiles: changed });
    writeFileSync(dest, `${JSON.stringify(receipt, null, 2)}\n`);
    console.error(
      `created .proofgate/receipts/${taskId}.json (diff-stamped: ${diffSha ? "yes" : "no — run 'proofgate stamp'"})\n` +
        `Fill intent / validation_plan / execution_evidence / result_summary, then: proofgate stamp && proofgate check`,
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
      console.error("proofgate receipt: pass exactly one of --write | --check");
      return 2;
    }
    if (skipGit || !baseRef) {
      console.error("proofgate receipt: needs git + a base ref to compute the diff");
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
      console.error(`proofgate receipt: git failed: ${String(e)}`);
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
      dest = join(".proofgate", "receipts", `${taskId}.json`);
    }
    const destAbs = join(cwd, dest);

    if (checkOnly) {
      if (!existsSync(destAbs)) {
        console.error(`proofgate receipt --check: no receipt at ${dest} — run 'proofgate receipt --write'`);
        return 1;
      }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(readFileSync(destAbs, "utf8"));
      } catch (e) {
        console.error(`proofgate receipt --check: ${dest} is not valid JSON: ${String(e)}`);
        return 1;
      }
      const report = checkMechanical(obj, mech);
      if (report.fresh) {
        console.error(`✓ ${dest} mechanical fields are fresh (diff_sha256 matches the committed diff)`);
        return 0;
      }
      for (const p of report.problems) console.error(`stale ❌ ${p}`);
      console.error("✗ receipt is stale — run 'proofgate receipt --write' to refresh, then commit.");
      return 1;
    }

    // --write
    if (!existsSync(destAbs)) {
      const taskId = sanitizeTaskId(arg("task", dest.replace(/^.*\/|\.json$/g, ""))!);
      const agentId = arg("agent", process.env.PROOFGATE_AGENT_ID || "agent")!;
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
        console.error(`proofgate receipt --write: ${dest} is not valid JSON: ${String(e)}`);
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
    console.error(`\nThen: git add ${dest} && commit && push  (pre-check: proofgate check)`);
    return 0;
  }

  if (!existsSync(receiptPath)) {
    console.error(
      `proofgate: no receipt found at ${receiptPath}.\n` +
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
      console.error("proofgate stamp: needs git + a --base ref to compute the diff");
      return 1;
    }
    let receiptObj: Record<string, unknown>;
    try {
      receiptObj = JSON.parse(rawReceipt);
    } catch (e) {
      console.error(`proofgate stamp: receipt is not valid JSON: ${String(e)}`);
      return 1;
    }
    let diffSha: string;
    let changed: string[];
    try {
      diffSha = computeDiffSha256(gitDiffExcludingReceipt(baseRef, cwd));
      changed = gitChangedFiles(baseRef, cwd).filter((f) => !isReceiptPath(f));
    } catch (e) {
      console.error(`proofgate stamp: git failed: ${String(e)}`);
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
      final: shape.pass ? "approve" : "revise",
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
        : "✗ pre-flight FAIL — fix the above before pushing. Tip: `proofgate stamp` fixes diff_sha256/changed_files.",
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
    final: shape.pass ? "approve" : "revise",
    reasons: [],
  };

  if (cmd === "shape") return shape.pass ? 0 : 1;

  // --- CI evidence integrity (run mode): corroborate against the real CI run (#6) ---
  // Don't trust the receipt's self-reported execution_evidence for these — read
  // the actual check-run conclusions for the PR head and require success. The
  // agent need not self-report status for these; CI is the source of truth.
  if (cmd === "run" && policy.ci_evidence_checks.length > 0) {
    const repo = process.env.GITHUB_REPOSITORY;
    const token = process.env.GITHUB_TOKEN;
    if (ci.provider === "github" && repo && token && ci.prNumber !== undefined) {
      try {
        const ev = await verifyCiEvidence(repo, ci.prNumber, token, policy.ci_evidence_checks);
        for (const n of ev.notes) console.error(`ci-evidence ✓ ${n}`);
        for (const e of ev.errors) {
          console.error(`ci-evidence ❌ ${e}`);
          shape.errors.push(e);
        }
        console.error(`ci-evidence gate: ${ev.pass ? "PASS" : "FAIL"}`);
        if (!ev.pass) {
          shape.pass = false;
          gate.final = "revise";
        } else {
          gate.reasons.push(
            `CI evidence corroborated against the real run (${ev.notes.join(", ")}) — not self-reported.`,
          );
        }
      } catch (e) {
        const msg = `ci-evidence: could not verify CI checks: ${String(e)}`;
        console.error(`ci-evidence ❌ ${msg}`);
        shape.errors.push(msg);
        shape.pass = false;
        gate.final = "revise";
      }
    } else {
      console.error("ci-evidence: configured but no GitHub PR context/token — skipped");
      gate.reasons.push("CI evidence configured but no GitHub PR context — not verified.");
    }
  }

  // --- Semantic review ---
  if (!shape.pass || !receipt) {
    gate.final = "revise";
    gate.reasons.push("semantic review skipped: shape gate failed — fix shape errors first");
  } else {
    const missionPath = arg("mission", policy.mission_file)!;
    if (!existsSync(missionPath)) {
      console.error(`proofgate: mission file not found at ${missionPath}`);
      return 1;
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("proofgate: ANTHROPIC_API_KEY is required for semantic review");
      return 1;
    }
    const mission = readFileSync(missionPath, "utf8");
    const diff = skipGit ? "" : getDiff(baseRef, cwd);

    const review = await semanticReview(mission, receipt, diff, policy, apiKey);
    gate.review = review;
    gate.final = review.verdict as Verdict;

    console.error(`semantic review: ${review.verdict} (confidence ${review.confidence})`);
    console.error(`  coverage: ${review.validation_coverage_notes}`);
    console.error(`  mission:  ${review.mission_alignment_notes}`);
    console.error(`  risk:     ${review.risk_notes}`);
  }

  // --- CI reporting ---
  if (cmd === "run") {
    if (ci.prNumber !== undefined && process.env.PROOFGATE_PR_NUMBER) {
      ci.prNumber = Number(process.env.PROOFGATE_PR_NUMBER);
    }
    const posted = await reportToCi(
      ci,
      renderComment(gate),
      gate.final === "approve",
      renderCiSummary(gate),
    ).catch((e) => {
      console.error(`proofgate: failed to post CI comment: ${e?.message ?? e}`);
      return false;
    });
    if (posted) {
      console.error(`posted gate result to PR #${ci.prNumber} (${ci.provider})`);
    } else {
      console.error("proofgate: no PR context detected — printing comment:\n");
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
    console.error(`proofgate: ${err?.message ?? err}`);
    process.exit(1);
  },
);
