import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { PolicySchema, type Policy } from "./types.js";
import { shapeCheck } from "./shape.js";
import { CANONICAL_DIR, LEGACY_DIR } from "./basedir.js";

/**
 * `plumb archive <slug>` — the closing end of the loop
 * (propose → work → prove → gate → ARCHIVE).
 *
 * A completed change folder's spec deltas get applied to the living specs
 * (`openspec/specs/` — the source of truth for how the system currently
 * behaves), then the change moves to `openspec/changes/archive/<date>-<slug>/`
 * with its full context preserved. Format and lifecycle follow OpenSpec's
 * conventions (MIT — see THIRD-PARTY.md) so artifacts interop both directions.
 *
 * The gate-before-archive rule: a change may only be archived once its
 * receipt passes the shape gate — proof precedes truth. `--force` overrides
 * with a warning (recorded in the output), never silently.
 *
 * Same law as the rest of the tool: deterministic file operations only. The
 * tool merges what the author wrote; it never writes spec content itself.
 */

// ── Spec parsing (OpenSpec requirement/scenario format) ─────────────────────
//
// A spec is made of requirement blocks:
//   ### Requirement: <name>
//   The system SHALL ...
//   #### Scenario: <case>
//   - GIVEN ... / WHEN ... / THEN ...
//
// A change's delta spec groups requirement blocks under delta sections:
//   ## ADDED Requirements      (appended to the living spec)
//   ## MODIFIED Requirements   (replaces the requirement with the same name)
//   ## REMOVED Requirements    (deleted from the living spec)

export interface RequirementBlock {
  /** The name after `### Requirement:` — the identity deltas match on. */
  name: string;
  /** The full block, from its `### Requirement:` line to before the next one. */
  body: string;
}

const REQ_HEADER = /^### Requirement:\s*(.+?)\s*$/;

/** Split a spec body into its preamble + ordered requirement blocks. */
export function parseRequirements(md: string): { preamble: string; blocks: RequirementBlock[] } {
  const lines = md.split("\n");
  const blocks: RequirementBlock[] = [];
  let preambleEnd = lines.length;
  let current: { name: string; start: number } | undefined;
  const flush = (end: number): void => {
    if (current) {
      blocks.push({
        name: current.name,
        body: lines.slice(current.start, end).join("\n").replace(/\n+$/, ""),
      });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const m = REQ_HEADER.exec(lines[i]);
    if (m) {
      if (!current) preambleEnd = i;
      flush(i);
      current = { name: m[1], start: i };
    }
  }
  flush(lines.length);
  const preamble = lines
    .slice(0, current || blocks.length > 0 ? preambleEnd : lines.length)
    .join("\n")
    .replace(/\n+$/, "");
  return { preamble, blocks };
}

export interface DeltaSpec {
  added: RequirementBlock[];
  modified: RequirementBlock[];
  removed: RequirementBlock[];
}

const DELTA_HEADER = /^## (ADDED|MODIFIED|REMOVED) Requirements\s*$/;

/** Parse a change's delta spec into its ADDED / MODIFIED / REMOVED groups. */
export function parseDeltaSpec(md: string): DeltaSpec {
  const lines = md.split("\n");
  const delta: DeltaSpec = { added: [], modified: [], removed: [] };
  let section: keyof DeltaSpec | undefined;
  let buf: string[] = [];
  const flushSection = (): void => {
    if (section && buf.length > 0) {
      delta[section].push(...parseRequirements(buf.join("\n")).blocks);
    }
    buf = [];
  };
  for (const line of lines) {
    const m = DELTA_HEADER.exec(line);
    if (m) {
      flushSection();
      section = m[1].toLowerCase() as keyof DeltaSpec;
      continue;
    }
    if (/^## /.test(line)) {
      // Any other H2 ends the current delta section.
      flushSection();
      section = undefined;
      continue;
    }
    if (section) buf.push(line);
  }
  flushSection();
  return delta;
}

/**
 * Apply one capability's delta to its living spec, per OpenSpec semantics:
 * ADDED appends, MODIFIED replaces the same-named requirement, REMOVED
 * deletes it. Mismatches are honest warnings, never silent: an ADDED that
 * already exists warns of competing requirements (kept both, faithful to
 * append semantics), a MODIFIED with no target is appended with a warning,
 * a REMOVED with no target is a no-op warning.
 */
export function applyDelta(
  living: string | undefined,
  delta: DeltaSpec,
  capability: string,
): { md: string; notes: string[]; warnings: string[] } {
  const notes: string[] = [];
  const warnings: string[] = [];
  const base = living ?? `# ${capability}\n`;
  const { preamble, blocks } = parseRequirements(base);
  const byName = new Map(blocks.map((b, i) => [b.name, i]));

  for (const mod of delta.modified) {
    const i = byName.get(mod.name);
    if (i === undefined) {
      warnings.push(
        `${capability}: MODIFIED '${mod.name}' not found in the living spec — appended instead (was this meant to be ADDED?)`,
      );
      byName.set(mod.name, blocks.length);
      blocks.push(mod);
    } else {
      blocks[i] = mod;
      notes.push(`${capability}: modified '${mod.name}'`);
    }
  }
  for (const add of delta.added) {
    if (byName.has(add.name)) {
      warnings.push(
        `${capability}: ADDED '${add.name}' already exists — appended anyway per OpenSpec semantics; you now have competing requirements (was this meant to be MODIFIED?)`,
      );
    }
    byName.set(add.name, blocks.length);
    blocks.push(add);
    notes.push(`${capability}: added '${add.name}'`);
  }
  for (const rem of delta.removed) {
    const i = blocks.findIndex((b) => b.name === rem.name);
    if (i === -1) {
      warnings.push(`${capability}: REMOVED '${rem.name}' not found in the living spec — nothing to delete`);
    } else {
      blocks.splice(i, 1);
      notes.push(`${capability}: removed '${rem.name}'`);
    }
  }
  const md = `${[preamble, ...blocks.map((b) => b.body)].filter((s) => s.trim() !== "").join("\n\n")}\n`;
  return { md, notes, warnings };
}

// ── The gate-before-archive rule ─────────────────────────────────────────────

/** Read `task_id` from a proposal.md front-matter (quoted or bare). */
export function taskIdFromProposal(proposal: string): string | undefined {
  const m = /^task_id:\s*"?([^"\n]+?)"?\s*$/m.exec(proposal);
  if (!m) return undefined;
  const v = m[1].trim();
  return v && !v.startsWith("TODO") ? v : undefined;
}

/**
 * Locate the change's receipt: `<dir>/receipts/<task_id>.json` in either the
 * canonical or the legacy config dir; falls back to scanning receipts/ for a
 * matching `task_id` field (the file may be named after the branch).
 */
export function findReceipt(cwd: string, taskId: string): string | undefined {
  for (const dir of [CANONICAL_DIR, LEGACY_DIR]) {
    const exact = join(dir, "receipts", `${taskId}.json`);
    if (existsSync(join(cwd, exact))) return exact;
  }
  for (const dir of [CANONICAL_DIR, LEGACY_DIR]) {
    const receipts = join(cwd, dir, "receipts");
    if (!existsSync(receipts)) continue;
    for (const f of readdirSync(receipts).filter((f) => f.endsWith(".json"))) {
      try {
        const j = JSON.parse(readFileSync(join(receipts, f), "utf8")) as { task_id?: unknown };
        if (j.task_id === taskId) return join(dir, "receipts", f);
      } catch {
        /* unparseable receipt — skip */
      }
    }
  }
  return undefined;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface ArchiveOptions {
  slug: string;
  cwd: string;
  force: boolean;
  policy?: Policy;
  /** Archive-folder date prefix (YYYY-MM-DD); defaults to today. */
  date?: string;
  log?: (line: string) => void;
}

export interface ArchiveResult {
  ok: boolean;
  archivedTo?: string;
  specsUpdated: string[];
  notes: string[];
  warnings: string[];
  errors: string[];
}

export function runArchive(opts: ArchiveOptions): ArchiveResult {
  const log = opts.log ?? ((l: string) => console.error(l));
  const policy = opts.policy ?? PolicySchema.parse({ version: "1.0" });
  const res: ArchiveResult = { ok: false, specsUpdated: [], notes: [], warnings: [], errors: [] };
  const changeRel = join("openspec", "changes", opts.slug);
  const changeAbs = join(opts.cwd, changeRel);

  if (opts.slug === "archive" || opts.slug.includes("/") || opts.slug.includes("..")) {
    res.errors.push(`'${opts.slug}' is not a change slug`);
    return res;
  }
  if (!existsSync(changeAbs)) {
    res.errors.push(`no change folder at ${changeRel}/ — is it already archived, or misspelled?`);
    return res;
  }

  // 1. Gate before archive: the change's receipt must pass the shape gate.
  //    (Shape-only, no git binding — at archive time the PR is merged, so the
  //    working tree has no diff to bind; the diff was bound when the gate ran.)
  const proposalPath = join(changeAbs, "proposal.md");
  const taskId = existsSync(proposalPath)
    ? taskIdFromProposal(readFileSync(proposalPath, "utf8"))
    : undefined;
  const receiptRel = taskId ? findReceipt(opts.cwd, taskId) : undefined;
  let gateProblem: string | undefined;
  if (!taskId) {
    gateProblem = `proposal.md has no linked task_id — cannot locate the change's receipt`;
  } else if (!receiptRel) {
    gateProblem = `no receipt found for task_id '${taskId}' (looked in ${CANONICAL_DIR}/receipts/ and ${LEGACY_DIR}/receipts/)`;
  } else {
    const { result } = shapeCheck(readFileSync(join(opts.cwd, receiptRel), "utf8"), policy, {
      skipGit: true,
    });
    if (result.pass) {
      res.notes.push(`gate: receipt ${receiptRel} passes the shape gate — proof precedes truth ✓`);
    } else {
      gateProblem = `receipt ${receiptRel} does not pass the shape gate: ${result.errors.join("; ")}`;
    }
  }
  if (gateProblem) {
    if (!opts.force) {
      res.errors.push(`${gateProblem}\n  Archive records proven work. Fix the receipt (plumb receipt --write + plumb check), or --force to override.`);
      return res;
    }
    res.warnings.push(`FORCED past the gate-before-archive rule: ${gateProblem}`);
    log(`plumb archive ⚠️  ${res.warnings[res.warnings.length - 1]}`);
  }

  // 2. Apply the change's spec deltas to the living specs.
  const deltaRoot = join(changeAbs, "specs");
  if (existsSync(deltaRoot)) {
    for (const capability of readdirSync(deltaRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)) {
      const deltaPath = join(deltaRoot, capability, "spec.md");
      if (!existsSync(deltaPath)) continue;
      const delta = parseDeltaSpec(readFileSync(deltaPath, "utf8"));
      if (delta.added.length + delta.modified.length + delta.removed.length === 0) {
        res.warnings.push(`${capability}: delta spec has no ADDED/MODIFIED/REMOVED sections — nothing applied`);
        continue;
      }
      const livingRel = join("openspec", "specs", capability, "spec.md");
      const livingAbs = join(opts.cwd, livingRel);
      const living = existsSync(livingAbs) ? readFileSync(livingAbs, "utf8") : undefined;
      const applied = applyDelta(living, delta, capability);
      mkdirSync(dirname(livingAbs), { recursive: true });
      writeFileSync(livingAbs, applied.md);
      res.specsUpdated.push(livingRel);
      res.notes.push(...applied.notes);
      res.warnings.push(...applied.warnings);
    }
  }

  // 3. Move the change folder to the archive (full context preserved).
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const destRel = join("openspec", "changes", "archive", `${date}-${opts.slug}`);
  const destAbs = join(opts.cwd, destRel);
  if (existsSync(destAbs)) {
    res.errors.push(`archive destination ${destRel}/ already exists — refusing to overwrite`);
    return res;
  }
  mkdirSync(dirname(destAbs), { recursive: true });
  renameSync(changeAbs, destAbs);
  res.archivedTo = destRel;
  res.ok = true;

  for (const n of res.notes) log(`  ${n}`);
  for (const w of res.warnings) log(`  ⚠️  ${w}`);
  log(
    `archived ${changeRel}/ → ${destRel}/` +
      (res.specsUpdated.length > 0
        ? `\n  living specs updated: ${res.specsUpdated.join(", ")}`
        : "\n  (no spec deltas to apply)"),
  );
  return res;
}
