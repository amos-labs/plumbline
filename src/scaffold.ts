import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Agent-installable scaffolding: `proofgate init` lays down everything a repo
 * needs to be gated (workflow + policy + mission + AGENTS.md + an example
 * receipt), and `proofgate new` scaffolds a fresh per-PR receipt. The goal is
 * "pull it in, read AGENTS.md, go" — no reverse-engineering the receipt shape.
 */

/** Bundled templates ship in the package (`files: ["templates"]`). From the
 *  compiled `dist/scaffold.js`, the package root is one level up. */
export function templatesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "templates");
}

export interface ScaffoldItem {
  dest: string;
  created: boolean;
  note?: string;
}

interface InitEntry {
  dest: string;
  src?: string;
  dir?: boolean;
}

/** What `init` lays down, in order. Dirs first, then files copied from templates. */
export const INIT_PLAN: InitEntry[] = [
  { dest: ".proofgate", dir: true },
  { dest: ".proofgate/receipts", dir: true },
  { dest: ".github/workflows", dir: true },
  { dest: ".github/workflows/proofgate.yml", src: "workflow.yml" },
  { dest: ".proofgate/policy.json", src: "policy.json" },
  { dest: ".proofgate/MISSION.md", src: "MISSION.md" },
  { dest: ".proofgate/AGENTS.md", src: "AGENTS.md" },
  { dest: ".proofgate/receipts/EXAMPLE.json", src: "receipt.example.json" },
];

/** Copy the bundled templates into `cwd`. Idempotent: never clobbers an
 *  existing file/dir — records it as left-as-is so re-running is safe. */
export function runInit(cwd: string): ScaffoldItem[] {
  const tdir = templatesDir();
  const out: ScaffoldItem[] = [];
  for (const item of INIT_PLAN) {
    const abs = join(cwd, item.dest);
    if (existsSync(abs)) {
      out.push({ dest: item.dest, created: false, note: "exists — left as-is" });
      continue;
    }
    if (item.dir) {
      mkdirSync(abs, { recursive: true });
      out.push({ dest: item.dest, created: true });
      continue;
    }
    let content = readFileSync(join(tdir, item.src!), "utf8");
    // The shipped workflow.yml carries a "# Copy to …" hint as its first line;
    // it's already in place once init writes it, so drop that line.
    if (item.src === "workflow.yml") content = content.replace(/^# Copy to [^\n]*\n/, "");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    out.push({ dest: item.dest, created: true });
  }
  return out;
}

/** Branch/ref → a filesystem-safe task id used for the receipt filename. */
export function sanitizeTaskId(ref: string): string {
  const cleaned = ref
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "TASK";
}

/** A fresh receipt prefilled with TODO placeholders + the real diff binding.
 *  `stamp`/`check` operate on it after the author fills the prose fields. */
export function newReceipt(opts: {
  taskId: string;
  agentId: string;
  diffSha256?: string;
  changedFiles?: string[];
}): Record<string, unknown> {
  return {
    receipt_version: "1.0",
    task_id: opts.taskId,
    agent_id: opts.agentId,
    intent:
      "TODO: what is this change for and why, in plain language (≥40 chars). The semantic review reads this.",
    self_modifying: false,
    policy_refs: [".proofgate/MISSION.md"],
    validation_plan: [
      {
        command: "TODO: the test/lint command that proves this change",
        reason: "TODO: why this validates the change",
        required: true,
      },
    ],
    execution_evidence: [
      {
        command: "TODO: the same command you actually ran",
        status: "passed",
        output_ref: "TODO: a short result, e.g. '12 examples, 0 failures'",
      },
    ],
    changed_files: opts.changedFiles ?? [],
    diff_sha256: opts.diffSha256 ?? "0".repeat(64),
    result_summary:
      "TODO: summarize the change and how it was verified (≥40 chars).",
  };
}
