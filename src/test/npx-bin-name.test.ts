import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression cover for the silently-dead `npx` quick start.
 *
 * Every invocation in the README (and in downstream repos' contributor docs)
 * has the shape:
 *
 *     npx -y "git+https://github.com/amos-labs/plumbline#v0.7.2" receipt --write
 *
 * When `npx <spec> <args>` runs a package, it resolves the binary to run by
 * looking for a bin entry whose NAME MATCHES THE PACKAGE NAME. This package is
 * called `plumbline`, but its bin map only declared `plumb` and `proofgate` —
 * so there was no `plumbline` bin, npx could not choose one, and the command
 * exited 0 having done nothing at all. No output, no error, exit code 0.
 *
 * That is the worst possible failure mode for a quick start: it looks like it
 * worked. Observed 2026-08-02 on npm 10.8.2 / Node 20 while trying to follow
 * the documented flow in the cuspr repo, whose contributors had fallen back to
 * hand-computing diff_sha256 with a bare `git diff | shasum` — which cannot
 * reproduce the hermetic binding, and cost four needless re-stamp commits.
 *
 * The invariant: the package name must always be a key in `bin`. `plumb` stays
 * as the short ergonomic alias and `proofgate` as the pre-rename one; neither
 * satisfies npx on its own.
 */

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  name: string;
  bin: Record<string, string>;
};

test("the package name is a bin entry, so `npx <spec> <cmd>` can resolve", () => {
  assert.ok(
    Object.hasOwn(pkg.bin, pkg.name),
    `package "${pkg.name}" has no bin named "${pkg.name}" (bins: ${Object.keys(pkg.bin).join(", ")}). ` +
      `npx resolves <spec> <args> to the bin matching the package name; without it every ` +
      `documented "npx -y <spec> <cmd>" exits 0 silently having done nothing.`,
  );
});

test("the historical aliases are still published", () => {
  // `plumb` is what the docs use for a local checkout, and `proofgate` is the
  // pre-rename name still baked into older repos' scripts. Dropping either
  // would break callers that never went through npx.
  assert.ok(Object.hasOwn(pkg.bin, "plumb"), "the `plumb` alias must stay");
  assert.ok(Object.hasOwn(pkg.bin, "proofgate"), "the `proofgate` alias must stay");
});

test("every bin points at the built entrypoint", () => {
  for (const [name, target] of Object.entries(pkg.bin)) {
    assert.equal(target, "dist/index.js", `bin "${name}" should point at dist/index.js, got "${target}"`);
  }
});
