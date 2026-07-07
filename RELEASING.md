# Releasing Plumbline

Plumbline uses [Semantic Versioning](https://semver.org/) and [Keep a
Changelog](https://keepachangelog.com/). Releases are **triggered by pushing a semver
tag** — the [`release` workflow](.github/workflows/release.yml) reacts to a pushed
`v*.*.*` tag by building, testing, and publishing a GitHub Release with notes drawn
from [CHANGELOG.md](CHANGELOG.md).

> **Cutting a release is a deliberate, human-triggered act.** CI does not create tags.
> A maintainer creates and pushes the tag; everything after that is automated.

## Versioning policy

- **MAJOR** (`v1` → `v2`) — a breaking change: receipt schema, policy schema, gate
  exit-code semantics, or action inputs change in a way that could break a consumer.
- **MINOR** (`v0.2.0` → `v0.3.0`) — new capability, backward compatible (a new command,
  a new policy dial, wording changes to gate output).
- **PATCH** (`v0.2.0` → `v0.2.1`) — bug fixes, docs, no behavior change to the contract.

Consumers pin the **moving major tag** (`@v1`) and get MINOR/PATCH automatically; a
MAJOR bump is an explicit opt-in. See [Pinning a version](README.md#pinning-a-version).

## Cutting a release (e.g. `v0.2.0`)

1. **Land everything for the release on `master`** via the normal gated PR flow.

2. **Set the version.** Bump `version` in `package.json` to the target (e.g. `0.2.0`)
   and open the [`Unreleased`] section of `CHANGELOG.md`: rename it to the new version
   with today's date, and add a fresh empty `## [Unreleased]` above it. Update the
   compare links at the bottom of the changelog. Merge this through the gate like any
   other change.

   > The release workflow **fails if the tag and `package.json` version disagree** — a
   > release must be honest about its own version.

3. **Tag the merge commit and push the tag:**

   ```bash
   git checkout master && git pull
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

4. **The workflow does the rest** — it checks out the tag, runs `tsc --noEmit`,
   `npm run build`, and `npm test`, verifies the tag matches `package.json`, extracts
   the matching `CHANGELOG.md` section as the release notes, and creates the GitHub
   Release. If a built `dist/` is present (e.g. once packaging is bundled), it also
   attaches a `plumbline-<tag>-dist.tgz` tarball plus a `.sha256` for verification;
   otherwise the release is source-only, which is fine — the composite action builds
   from source at use time.

5. **Verify** the Release appears under **Releases** with the right notes (and asset, if
   any).

## Moving the major tag (e.g. `v1`)

Consumers pin `@v1` (a *moving* major tag) so they track the latest `v1.x.y` without
editing their workflow. After the full semver release exists, fast-forward the major tag
to the same commit and force-push it:

```bash
# after v1.2.0 is released and its commit is on master:
git tag -f v1 v1.2.0     # move the major alias to the release commit
git push origin v1 --force
```

- Only move a major tag **forward** to a released commit, and only within the same
  major line (`v1` never points at a `v2.x` commit).
- The current floating `v0` tag predates this process; new consumers should pin `@v0.2.0`
  or a future `@v1`.

## First release (bootstrap)

The very first tagged release (`v0.2.0`) is cut by a human once this process merges —
push `v0.2.0` per the steps above. There is no `v1` yet; introduce it (and start moving
`@v1`) at the first release the maintainers consider API-stable.
