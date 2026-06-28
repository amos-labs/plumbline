/**
 * Choosing the right receipt when a PR's diff contains MORE THAN ONE
 * `.proofgate/receipts/<task_id>.json`.
 *
 * This happens in practice when a merge re-adds an old branch's receipt
 * alongside the PR's real one. The old behaviour ("use the first") could
 * evaluate the WRONG receipt against the diff — e.g. a stale
 * `self_modifying:false` receipt failing a PR whose real receipt correctly
 * declared `self_modifying:true`. We pick deterministically instead, and
 * NEVER silently grab one:
 *
 *   1. `task_id` is contained in the PR head branch (the intent signal), else
 *   2. `diff_sha256` binds to THIS PR's actual diff (the content signal —
 *      the real receipt is hashed against this diff; a stale re-added one
 *      is not), else
 *   3. throw — fail loudly rather than evaluate the wrong receipt.
 */
export interface ReceiptCandidate {
  /** Path as it appears in the diff, e.g. `.proofgate/receipts/foo.json`. */
  path: string;
  /** `task_id` field from the receipt JSON, if readable. */
  taskId?: string;
  /** `diff_sha256` field from the receipt JSON, if readable. */
  diffSha256?: string;
}

export function pickReceipt(
  candidates: ReceiptCandidate[],
  ctx: { branch?: string; actualSha?: string },
): string {
  if (candidates.length === 0) {
    throw new Error("proofgate: no candidate receipts to choose from");
  }
  if (candidates.length === 1) return candidates[0].path;

  // 1. task_id ↔ PR head branch (e.g. branch `feat/finance-tenant` ⊃ task_id `finance-tenant`).
  if (ctx.branch) {
    const b = ctx.branch.toLowerCase();
    const byTask = candidates.filter(
      (c) => c.taskId && b.includes(c.taskId.toLowerCase()),
    );
    if (byTask.length === 1) return byTask[0].path;
  }

  // 2. diff_sha256 binds to THIS diff. The PR's real receipt is hashed against
  //    the current diff; a stale receipt re-added by a merge is not — so this
  //    deterministically excludes the stale one.
  if (ctx.actualSha) {
    const bySha = candidates.filter((c) => c.diffSha256 === ctx.actualSha);
    if (bySha.length === 1) return bySha[0].path;
  }

  // 3. Could not disambiguate → fail explicitly. Never silently pick one.
  throw new Error(
    `proofgate: ${candidates.length} candidate receipts in the diff ` +
      `(${candidates.map((c) => c.path).join(", ")}) — none uniquely matches the ` +
      `PR branch (task_id) or this diff's content (diff_sha256). A merge may have ` +
      `re-added a stale receipt; ensure exactly one receipt under ` +
      `.proofgate/receipts/ belongs to this PR (or pass --receipt to select it).`,
  );
}
