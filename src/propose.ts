import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchesAny } from "./glob.js";

/**
 * `proofgate propose` — the intake end of the loop (propose → work → prove →
 * gate). One command births the GitHub issue and its OpenSpec change folder
 * ALREADY LINKED, so task_id ↔ contract-folder linkage can never drift — the
 * same reason `receipt --write` reuses the gate's own hash code.
 *
 * Same law as receipt --write: deterministic scaffolding only. The tool lays
 * down structure (folder, stubs, issue, links, an informational self_modifying
 * prediction); the judgment content — actual spec details, acceptance criteria
 * — is authored by the human/agent afterwards. Automate the bookkeeping, never
 * the judgment.
 */

/** Kebab slug for the change folder, from the ask's title. */
export function slugFromTitle(title: string): string {
  const s = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "change";
}

/** proposal.md — front-matter (linkage lives here) + TODO-stubbed judgment sections. */
export function proposalMd(opts: { title: string; body?: string; taskId?: string }): string {
  const fm = [
    "---",
    `title: ${opts.title}`,
    `task_id: ${opts.taskId ?? "TODO — issue number (written back by propose when the issue is created)"}`,
    `status: proposed`,
    "---",
  ].join("\n");
  return `${fm}

# ${opts.title}

${opts.body?.trim() || "TODO — the ask, in the requester's words."}

## Why

TODO — the problem this solves and why now. The judgment half; the tool never writes this.

## What Changes

TODO — the observable behavior/contract changes, stated so the gate's semantic review can check the diff against them.

## Scope / Non-goals

TODO — what is explicitly out of scope.
`;
}

/** tasks.md — the acceptance checklist stub (receipt.validation_plan grows from this). */
export function tasksMd(title: string): string {
  return `# Tasks — ${title}

- [ ] TODO — acceptance task 1 (each task should be provable by a command in the receipt's validation_plan)
- [ ] TODO — acceptance task 2
- [ ] receipt: \`proofgate receipt --write\`, fill judgment fields, \`proofgate check\`
`;
}

/** The issue body: proposal summary + checklist + the contract pointer line. */
export function issueBody(opts: { body?: string; slug?: string }): string {
  const contract = opts.slug
    ? `\n\nContract: \`openspec/changes/${opts.slug}/\` (proposal.md + specs/ + tasks.md — fill the TODO sections before starting work)`
    : "";
  return `${opts.body?.trim() || "TODO — describe the ask."}

## Acceptance
- [ ] Contract sections (Why / What Changes / Scope) filled and approved
- [ ] Work lands with a proof receipt (\`proofgate receipt --write\`) bound to this issue${contract}
`;
}

/** Write the created issue number into proposal.md front-matter (task_id linkage). */
export function writeBackTaskId(proposal: string, issueNumber: number): string {
  return proposal.replace(/^task_id: .*$/m, `task_id: "${issueNumber}"`);
}

export interface ProposePrediction {
  selfModifying: boolean;
  reasons: string[];
}

/**
 * Informational self_modifying prediction: if the ask names path-ish tokens
 * matching protected globs, or contains a glob's literal core segment as a
 * word, flag it. Purely a heads-up printed at intake — the receipt derives the
 * real value from the actual diff later.
 */
export function predictSelfModifying(ask: string, protectedPaths: string[]): ProposePrediction {
  const reasons: string[] = [];
  const tokens = ask
    .split(/\s+/)
    .map((t) => t.replace(/[^\w./-]+/g, ""))
    .filter((t) => t.includes("/") || /\.\w+$/.test(t));
  for (const t of tokens) {
    const g = matchesAny(t, protectedPaths);
    if (g) reasons.push(`ask names '${t}' which matches protected glob '${g}'`);
  }
  const words = new Set(ask.toLowerCase().split(/[^a-z0-9._-]+/));
  for (const glob of protectedPaths) {
    const core = glob.replace(/\*+/g, "").replace(/^\/+|\/+$/g, "");
    if (core && !core.includes("/") && words.has(core.toLowerCase())) {
      if (!reasons.some((r) => r.includes(`'${glob}'`))) {
        reasons.push(`ask mentions '${core}' (protected glob '${glob}')`);
      }
    }
  }
  return { selfModifying: reasons.length > 0, reasons };
}

export type GhRunner = (args: string[], cwd: string) => string;

export const defaultGhRunner: GhRunner = (args, cwd) =>
  execFileSync("gh", args, { cwd, encoding: "utf8" });

export interface ProposeOptions {
  title: string;
  body?: string;
  repo?: string;
  lite: boolean;
  task?: string;
  cwd: string;
  protectedPaths: string[];
  gh?: GhRunner;
  log?: (line: string) => void;
}

export interface ProposeResult {
  slug?: string;
  folder?: string;
  issueNumber?: number;
  issueUrl?: string;
  ghCommand?: string; // printed fallback when gh is unavailable/fails
  prediction: ProposePrediction;
}

/** Orchestrate: scaffold the change folder (unless --lite), open the issue, link back. */
export function runPropose(opts: ProposeOptions): ProposeResult {
  const log = opts.log ?? ((l: string) => console.error(l));
  const gh = opts.gh ?? defaultGhRunner;
  const prediction = predictSelfModifying(`${opts.title} ${opts.body ?? ""}`, opts.protectedPaths);
  const result: ProposeResult = { prediction };

  // 1. Scaffold the OpenSpec change folder (skipped entirely with --lite).
  let proposalPath: string | undefined;
  if (!opts.lite) {
    const slug = slugFromTitle(opts.title);
    const folder = join("openspec", "changes", slug);
    const abs = join(opts.cwd, folder);
    result.slug = slug;
    result.folder = folder;
    if (existsSync(abs)) {
      log(`propose: ${folder}/ already exists — left as-is (scaffolding is never destructive).`);
      proposalPath = join(abs, "proposal.md");
    } else {
      mkdirSync(join(abs, "specs"), { recursive: true });
      proposalPath = join(abs, "proposal.md");
      writeFileSync(proposalPath, proposalMd({ title: opts.title, body: opts.body, taskId: opts.task }));
      writeFileSync(join(abs, "tasks.md"), tasksMd(opts.title));
      writeFileSync(
        join(abs, "specs", ".gitkeep"),
        "", // specs are authored per-capability once the contract is agreed
      );
      log(`created ${folder}/ (proposal.md + tasks.md + specs/) — fill the TODO sections; the tool never writes judgment content.`);
    }
  }

  // 2. Open the GitHub issue via gh (graceful: print the command if gh fails).
  const ghArgs = ["issue", "create", "--title", opts.title, "--body", issueBody({ body: opts.body, slug: result.slug })];
  if (!opts.lite) ghArgs.push("--label", "spec-carrying");
  if (opts.repo) ghArgs.push("--repo", opts.repo);
  let out: string | undefined;
  try {
    out = gh(ghArgs, opts.cwd).trim();
  } catch {
    if (!opts.lite) {
      // The label may not exist on the repo — retry once without it.
      try {
        out = gh(ghArgs.filter((a, i) => !(a === "--label" || ghArgs[i - 1] === "--label")), opts.cwd).trim();
        log("propose: 'spec-carrying' label unavailable — issue created without it (create the label once to enable it).");
      } catch {
        /* fall through to the printed command */
      }
    }
  }
  if (out) {
    result.issueUrl = out.split("\n").pop();
    const m = result.issueUrl?.match(/\/issues\/(\d+)/);
    if (m) result.issueNumber = Number(m[1]);
    log(`issue created: ${result.issueUrl}`);
  } else {
    // Shell single-quoting (multi-line-safe) — JSON.stringify would bake literal \n into the body.
    const shq = (a: string): string => (/^[\w./=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
    result.ghCommand = `gh ${ghArgs.map(shq).join(" ")}`;
    log(`propose: gh unavailable/failed — run this yourself:\n  ${result.ghCommand}`);
  }

  // 3. Write the issue number back into proposal.md front-matter (born linked).
  if (result.issueNumber !== undefined && proposalPath && existsSync(proposalPath)) {
    writeFileSync(proposalPath, writeBackTaskId(readFileSync(proposalPath, "utf8"), result.issueNumber));
    log(`linked: proposal.md task_id ↔ issue #${result.issueNumber}`);
  }

  // 4. Informational prediction (the receipt derives the real value from the diff).
  if (prediction.selfModifying) {
    log(`prediction: this work will likely be self_modifying — ${prediction.reasons.join("; ")}`);
    log("  (informational only — `proofgate receipt --write` derives the real value from the actual diff)");
  }
  return result;
}
