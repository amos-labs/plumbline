import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { baseDir } from "./basedir.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Agent-installable scaffolding: `plumb init` lays down everything a repo
 * needs to be gated (workflow + policy + mission + AGENTS.md + an example
 * receipt), and `plumb new` scaffolds a fresh per-PR receipt. The goal is
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
  { dest: "<dir>", dir: true },
  { dest: "<dir>/receipts", dir: true },
  { dest: ".github/workflows", dir: true },
  { dest: ".github/workflows/plumbline.yml", src: "workflow.yml" },
  { dest: "<dir>/policy.json", src: "policy.json" },
  { dest: "<dir>/MISSION.md", src: "MISSION.md" },
  { dest: "<dir>/AGENTS.md", src: "AGENTS.md" },
  { dest: "<dir>/receipts/EXAMPLE.json", src: "receipt.example.json" },
];

/** Copy the bundled templates into `cwd`. Idempotent: never clobbers an
 *  existing file/dir — records it as left-as-is so re-running is safe. */
export function runInit(cwd: string): ScaffoldItem[] {
  const tdir = templatesDir();
  const out: ScaffoldItem[] = [];
  const dir = baseDir(cwd);
  for (const item of INIT_PLAN) {
    const dest = item.dest.replace("<dir>", dir);
    const abs = join(cwd, dest);
    if (existsSync(abs)) {
      out.push({ dest, created: false, note: "exists — left as-is" });
      continue;
    }
    if (item.dir) {
      mkdirSync(abs, { recursive: true });
      out.push({ dest, created: true });
      continue;
    }
    // Templates are authored with the canonical dir; rewrite for legacy repos.
    let content = readFileSync(join(tdir, item.src!), "utf8").replaceAll(".plumbline/", `${dir}/`);
    // The shipped workflow.yml carries a "# Copy to …" hint as its first line;
    // it's already in place once init writes it, so drop that line.
    if (item.src === "workflow.yml") content = content.replace(/^# Copy to [^\n]*\n/, "");
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    out.push({ dest, created: true });
  }
  return out;
}

/**
 * Single source of truth for the receipt field contract. Drives three
 * discoverability surfaces so none can drift: `plumb schema` (CLI), the
 * `_help` block in a scaffolded receipt, and the AGENTS.md reference. The hard
 * rules themselves live in the zod schema (types.ts) — this describes them.
 */
export interface FieldRef {
  field: string;
  type: string;
  required: boolean;
  allowed?: string[];
  note: string;
}

export const RECEIPT_FIELD_REFERENCE: FieldRef[] = [
  { field: "receipt_version", type: "string", required: true, allowed: ["1.0"], note: "schema version" },
  { field: "task_id", type: "string", required: true, note: "ticket/issue/branch id (also the receipt filename)" },
  { field: "agent_id", type: "string", required: true, note: "which agent or human did the work" },
  { field: "intent", type: "string (≥40 chars)", required: true, note: "what + why, plain language — the semantic review reads this" },
  { field: "self_modifying", type: "boolean", required: true, allowed: ["true", "false"], note: "MUST be true if changed_files touch policy.protected_paths; touching one with false is a hard fail; true routes to human review" },
  { field: "policy_refs", type: "string[] (≥1)", required: true, note: "policy/mission docs you read" },
  { field: "validation_plan", type: "object[] (≥1)", required: true, note: "each: { command, reason, required }" },
  { field: "validation_plan[].required", type: "boolean", required: true, allowed: ["true", "false"], note: "is this check mandatory" },
  { field: "execution_evidence", type: "object[] (≥1)", required: true, note: "each: { command, status, output_ref?, skip_reason? }" },
  { field: "execution_evidence[].status", type: "enum", required: true, allowed: ["passed", "failed", "skipped"], note: "required steps must be 'passed'; use skip_reason when 'skipped'" },
  { field: "changed_files", type: "string[] (≥1)", required: true, note: "set by `plumb receipt --write` — don't hand-edit" },
  { field: "diff_sha256", type: "string (64-char lowercase hex)", required: true, note: "set by `plumb receipt --write` — never hand-edit" },
  { field: "result_summary", type: "string (≥40 chars)", required: true, note: "what changed + how it was verified" },
];

/** Compact field→rule map embedded as `_help` in a scaffolded receipt. The gate
 *  ignores unknown keys, so it's safe to leave in (or delete before commit). */
export function schemaHelpBlock(): Record<string, string> {
  const help: Record<string, string> = {
    _note: "Allowed values + requirements per field (this _help block is ignored by the gate — keep or delete). Run `plumb schema` for the full reference.",
  };
  for (const f of RECEIPT_FIELD_REFERENCE) {
    const allowed = f.allowed ? `one of: ${f.allowed.join(" | ")} — ` : "";
    help[f.field] = `${allowed}${f.required ? "required" : "optional"} — ${f.note}`;
  }
  return help;
}

/** Human-readable receipt schema reference for `plumb schema`. */
export function formatSchemaReference(): string {
  const lines: string[] = [
    "plumbline receipt schema (.plumbline/receipts/<task_id>.json — legacy .proofgate/ also works)",
    "",
  ];
  const width = Math.max(...RECEIPT_FIELD_REFERENCE.map((f) => f.field.length));
  for (const f of RECEIPT_FIELD_REFERENCE) {
    const req = f.required ? "required" : "optional";
    const allowed = f.allowed ? `  allowed: ${f.allowed.join(" | ")}` : "";
    lines.push(`  ${f.field.padEnd(width)}  ${f.type}  [${req}]${allowed}`);
    lines.push(`  ${" ".repeat(width)}  ${f.note}`);
  }
  lines.push("");
  lines.push("changed_files + diff_sha256 are filled by `plumb receipt --write` (never hand-edit).");
  lines.push("Scaffold one with: plumb receipt --write   ·   validate locally with: plumb check");
  return lines.join("\n");
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
    _help: schemaHelpBlock(),
    receipt_version: "1.0",
    task_id: opts.taskId,
    agent_id: opts.agentId,
    intent:
      "TODO: what is this change for and why, in plain language (≥40 chars). The semantic review reads this.",
    self_modifying: false,
    policy_refs: [".plumbline/MISSION.md"],
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
