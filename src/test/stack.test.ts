import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectStack,
  hasDockerfile,
  migrationVersion,
  maxMigrationVersion,
  checkMigrationCollision,
  runMigrationGuard,
  isStackId,
} from "../stack.js";

function repo(fixture: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "plumbline-stack-"));
  fixture(dir);
  return dir;
}

test("detectStack: rust-sqlx when Cargo.toml + migrations/ + sqlx dep", () => {
  const dir = repo((d) => {
    writeFileSync(join(d, "Cargo.toml"), '[dependencies]\nsqlx = "0.8"\n');
    mkdirSync(join(d, "migrations"));
  });
  assert.equal(detectStack(dir), "rust-sqlx");
});

test("detectStack: detects sqlx via Cargo.lock when not in Cargo.toml", () => {
  const dir = repo((d) => {
    writeFileSync(join(d, "Cargo.toml"), "[workspace]\nmembers = [\"crate\"]\n");
    writeFileSync(join(d, "Cargo.lock"), '[[package]]\nname = "sqlx"\nversion = "0.8.2"\n');
    mkdirSync(join(d, "migrations"));
  });
  assert.equal(detectStack(dir), "rust-sqlx");
});

test("detectStack: undefined without Cargo.toml, without migrations/, or without sqlx", () => {
  assert.equal(detectStack(repo(() => {})), undefined);
  assert.equal(
    detectStack(repo((d) => writeFileSync(join(d, "Cargo.toml"), '[dependencies]\nsqlx = "0.8"\n'))),
    undefined,
    "no migrations/ → not rust-sqlx",
  );
  assert.equal(
    detectStack(
      repo((d) => {
        writeFileSync(join(d, "Cargo.toml"), '[dependencies]\nserde = "1"\n');
        mkdirSync(join(d, "migrations"));
      }),
    ),
    undefined,
    "Cargo + migrations but no sqlx → not rust-sqlx",
  );
});

test("hasDockerfile: true only when a root Dockerfile exists", () => {
  assert.equal(hasDockerfile(repo(() => {})), false);
  assert.equal(hasDockerfile(repo((d) => writeFileSync(join(d, "Dockerfile"), "FROM scratch\n"))), true);
});

test("isStackId: only known presets", () => {
  assert.equal(isStackId("rust-sqlx"), true);
  assert.equal(isStackId("go-sqlc"), false);
});

test("migrationVersion: parses the leading numeric version, null for non-migrations", () => {
  assert.equal(migrationVersion("20260527000057_seed.sql"), 20260527000057);
  assert.equal(migrationVersion("migrations/0001_init.sql"), 1);
  assert.equal(migrationVersion("migrations/0002_x.up.sql"), 2);
  assert.equal(migrationVersion("README.md"), null);
  assert.equal(migrationVersion(".keep"), null);
});

test("maxMigrationVersion: max across a set, 0 for none", () => {
  assert.equal(maxMigrationVersion([]), 0);
  assert.equal(maxMigrationVersion(["0001_a.sql", "0003_c.sql", "0002_b.sql"]), 3);
  assert.equal(maxMigrationVersion(["README.md"]), 0);
});

test("checkMigrationCollision: PASS when every new version > base max", () => {
  const res = checkMigrationCollision(["20260601000000_new.sql"], ["20260527000057_old.sql"]);
  assert.equal(res.ok, true);
  assert.equal(res.baseMax, 20260527000057);
  assert.deepEqual(res.errors, []);
});

test("checkMigrationCollision: FAIL when a new version <= base max (the collision)", () => {
  const res = checkMigrationCollision(["0002_dup.sql"], ["0001_a.sql", "0003_c.sql"]);
  assert.equal(res.ok, false);
  assert.equal(res.baseMax, 3);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /version 2 <= base branch max 3/);
});

test("checkMigrationCollision: equal version is a collision (must sort strictly after)", () => {
  const res = checkMigrationCollision(["0003_same.sql"], ["0003_existing.sql"]);
  assert.equal(res.ok, false);
});

test("checkMigrationCollision: ignores non-migration files, PASS with no new migrations", () => {
  const res = checkMigrationCollision(["migrations/README.md"], ["0005_x.sql"]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.added, []);
});

test("checkMigrationCollision: first migration on an empty base passes", () => {
  const res = checkMigrationCollision(["0001_init.sql"], []);
  assert.equal(res.ok, true);
  assert.equal(res.baseMax, 0);
});

// --- runMigrationGuard CLI path (#8): git-reading wrapper over the pure logic ---

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** Build a tiny git repo: a base commit with one migration, then a branch. */
function migrationRepo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "pl-mig-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.test"]);
  git(dir, ["config", "user.name", "t"]);
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "migrations", "20260101000000_init.sql"), "-- init\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["checkout", "-q", "-b", "feat"]);
  return { dir, base };
}

test("runMigrationGuard: PASS when the new migration sorts after base max", () => {
  const { dir, base } = migrationRepo();
  writeFileSync(join(dir, "migrations", "20260202000000_new.sql"), "-- new\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "add higher migration"]);
  const res = runMigrationGuard(dir, base, "migrations");
  assert.equal(res.ok, true);
  assert.equal(res.baseMax, 20260101000000);
  assert.deepEqual(res.added, [20260202000000]);
});

test("runMigrationGuard: FAIL when a new migration collides with (<=) base max", () => {
  const { dir, base } = migrationRepo();
  // Lower version than the base's 20260101000000 — the collision.
  writeFileSync(join(dir, "migrations", "20251231000000_late.sql"), "-- collides\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "add colliding migration"]);
  const res = runMigrationGuard(dir, base, "migrations");
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /20251231000000_late\.sql/.test(e) && /base branch max/.test(e)));
});
