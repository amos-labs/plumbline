import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRequirements,
  parseDeltaSpec,
  applyDelta,
  taskIdFromProposal,
  findReceipt,
  runArchive,
} from "../archive.js";
import { specsReadme } from "../propose.js";

const REQ_TIMEOUT = `### Requirement: Session Timeout
The system SHALL expire a session after 30 minutes of inactivity.

#### Scenario: Idle timeout
- GIVEN an authenticated session
- WHEN 30 minutes pass with no activity
- THEN the session is invalidated and the user must re-authenticate`;

const REQ_LOGIN = `### Requirement: Login Rate Limit
The system SHALL reject more than 5 failed logins per minute per account.

#### Scenario: Sixth attempt rejected
- GIVEN 5 failed logins within a minute
- WHEN a sixth attempt arrives
- THEN it is rejected with a retry-after`;

// A receipt that passes the shape gate (skipGit): plan step has matching
// passed evidence; intent/result_summary long enough; valid sha shape.
function passingReceipt(taskId: string): string {
  return JSON.stringify({
    receipt_version: "1.0",
    task_id: taskId,
    agent_id: "test-agent",
    intent: "Add a session timeout so idle authenticated sessions expire and cannot be replayed.",
    self_modifying: false,
    policy_refs: [".plumbline/MISSION.md"],
    validation_plan: [{ command: "npm test", reason: "asserts the timeout behavior", required: true }],
    execution_evidence: [{ command: "npm test", status: "passed", output_ref: "42 passing" }],
    changed_files: ["src/session.ts"],
    diff_sha256: "a".repeat(64),
    result_summary: "Sessions now expire after 30 minutes idle; covered by an integration test.",
  });
}

/** Fixture repo: a change folder with an auth delta + a receipt in `receiptDir`. */
function fixture(opts: { receiptDir?: string; receipt?: string; delta?: string; living?: string }): string {
  const cwd = mkdtempSync(join(tmpdir(), "plumb-archive-"));
  const change = join(cwd, "openspec", "changes", "add-timeout");
  mkdirSync(join(change, "specs", "auth"), { recursive: true });
  writeFileSync(
    join(change, "proposal.md"),
    `---\ntitle: Add timeout\ntask_id: "84"\nstatus: proposed\n---\n\n# Add timeout\n`,
  );
  writeFileSync(join(change, "tasks.md"), "# Tasks\n- [x] done\n");
  writeFileSync(
    join(change, "specs", "auth", "spec.md"),
    opts.delta ?? `## ADDED Requirements\n\n${REQ_TIMEOUT}\n`,
  );
  if (opts.living) {
    mkdirSync(join(cwd, "openspec", "specs", "auth"), { recursive: true });
    writeFileSync(join(cwd, "openspec", "specs", "auth", "spec.md"), opts.living);
  }
  if (opts.receipt) {
    const dir = opts.receiptDir ?? ".plumbline";
    mkdirSync(join(cwd, dir, "receipts"), { recursive: true });
    writeFileSync(join(cwd, dir, "receipts", "84.json"), opts.receipt);
  }
  return cwd;
}

const quiet = (): void => {};

test("parseRequirements: preamble + blocks by name", () => {
  const md = `# auth\n\nPurpose line.\n\n${REQ_TIMEOUT}\n\n${REQ_LOGIN}\n`;
  const { preamble, blocks } = parseRequirements(md);
  assert.match(preamble, /# auth/);
  assert.deepEqual(
    blocks.map((b) => b.name),
    ["Session Timeout", "Login Rate Limit"],
  );
  assert.match(blocks[0].body, /GIVEN an authenticated session/);
});

test("parseDeltaSpec: ADDED / MODIFIED / REMOVED sections", () => {
  const md = `## ADDED Requirements\n\n${REQ_TIMEOUT}\n\n## REMOVED Requirements\n\n### Requirement: Login Rate Limit\nReason: superseded.\n`;
  const d = parseDeltaSpec(md);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].name, "Session Timeout");
  assert.equal(d.modified.length, 0);
  assert.equal(d.removed[0].name, "Login Rate Limit");
});

test("applyDelta: ADDED appends, MODIFIED replaces, REMOVED deletes — mismatches warn", () => {
  const living = `# auth\n\n${REQ_LOGIN}\n`;
  const modified = REQ_LOGIN.replace("5 failed", "3 failed");
  const out = applyDelta(
    living,
    {
      added: parseRequirements(REQ_TIMEOUT).blocks,
      modified: parseRequirements(modified).blocks,
      removed: [{ name: "Ghost Requirement", body: "### Requirement: Ghost Requirement" }],
    },
    "auth",
  );
  assert.match(out.md, /reject more than 3 failed/); // modified in place
  assert.doesNotMatch(out.md, /reject more than 5 failed/);
  assert.match(out.md, /Session Timeout/); // added appended
  assert.ok(out.warnings.some((w) => w.includes("Ghost Requirement")));
  // Duplicate ADDED warns about competing requirements.
  const dup = applyDelta(out.md, { added: parseRequirements(REQ_TIMEOUT).blocks, modified: [], removed: [] }, "auth");
  assert.ok(dup.warnings.some((w) => w.includes("competing")));
});

test("taskIdFromProposal: quoted, bare, and TODO placeholder", () => {
  assert.equal(taskIdFromProposal(`---\ntask_id: "84"\n---`), "84");
  assert.equal(taskIdFromProposal(`---\ntask_id: ISSUE-9\n---`), "ISSUE-9");
  assert.equal(taskIdFromProposal(`---\ntask_id: TODO — issue number\n---`), undefined);
});

test("archive happy path: gate passes, deltas applied, folder moved (dated)", () => {
  const cwd = fixture({ receipt: passingReceipt("84"), living: `# auth\n\n${REQ_LOGIN}\n` });
  const res = runArchive({ slug: "add-timeout", cwd, force: false, date: "2026-01-02", log: quiet });
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.ok(res.notes.some((n) => n.includes("proof precedes truth")));
  const living = readFileSync(join(cwd, "openspec", "specs", "auth", "spec.md"), "utf8");
  assert.match(living, /Session Timeout/);
  assert.match(living, /Login Rate Limit/); // pre-existing requirement kept
  assert.ok(existsSync(join(cwd, "openspec", "changes", "archive", "2026-01-02-add-timeout", "proposal.md")));
  assert.ok(!existsSync(join(cwd, "openspec", "changes", "add-timeout")));
});

test("gate-before-archive: no receipt refuses; --force proceeds loudly", () => {
  const cwd = fixture({});
  const refused = runArchive({ slug: "add-timeout", cwd, force: false, date: "2026-01-02", log: quiet });
  assert.equal(refused.ok, false);
  assert.ok(refused.errors[0].includes("no receipt found"));
  assert.ok(existsSync(join(cwd, "openspec", "changes", "add-timeout"))); // untouched
  const forced = runArchive({ slug: "add-timeout", cwd, force: true, date: "2026-01-02", log: quiet });
  assert.equal(forced.ok, true);
  assert.ok(forced.warnings.some((w) => w.includes("FORCED")));
});

test("gate-before-archive: shape-failing receipt refuses with the reason", () => {
  const bad = JSON.parse(passingReceipt("84"));
  bad.execution_evidence[0].status = "failed"; // required step without passing evidence
  const cwd = fixture({ receipt: JSON.stringify(bad) });
  const res = runArchive({ slug: "add-timeout", cwd, force: false, log: quiet });
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].includes("does not pass the shape gate"));
});

test("legacy .proofgate/ receipts dir works unchanged", () => {
  const cwd = fixture({ receipt: passingReceipt("84"), receiptDir: ".proofgate" });
  assert.equal(findReceipt(cwd, "84"), join(".proofgate", "receipts", "84.json"));
  const res = runArchive({ slug: "add-timeout", cwd, force: false, date: "2026-01-02", log: quiet });
  assert.equal(res.ok, true, res.errors.join("; "));
});

test("findReceipt: falls back to scanning by task_id field when filename differs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "plumb-archive-"));
  mkdirSync(join(cwd, ".plumbline", "receipts"), { recursive: true });
  writeFileSync(join(cwd, ".plumbline", "receipts", "my-branch.json"), passingReceipt("84"));
  assert.equal(findReceipt(cwd, "84"), join(".plumbline", "receipts", "my-branch.json"));
});

test("refuses to overwrite an existing archive destination; bad slugs rejected", () => {
  const cwd = fixture({ receipt: passingReceipt("84") });
  mkdirSync(join(cwd, "openspec", "changes", "archive", "2026-01-02-add-timeout"), { recursive: true });
  const res = runArchive({ slug: "add-timeout", cwd, force: false, date: "2026-01-02", log: quiet });
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].includes("already exists"));
  for (const slug of ["archive", "../up", "a/b"]) {
    assert.equal(runArchive({ slug, cwd, force: true, log: quiet }).ok, false);
  }
});

test("format round-trip: the specs/README.md example parses as a valid delta", () => {
  const example = /```markdown\n([\s\S]*?)```/.exec(specsReadme());
  assert.ok(example, "specs README carries a fenced example");
  const d = parseDeltaSpec(example![1]);
  assert.equal(d.added[0].name, "Session Timeout");
  assert.match(d.added[0].body, /- GIVEN an authenticated session/);
  assert.equal(d.modified.length, 1);
  assert.equal(d.removed.length, 1);
});
