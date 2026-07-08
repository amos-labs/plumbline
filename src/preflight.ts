import type { ShapeResult } from "./types.js";

/**
 * Render the LOCAL shape pre-flight result (#39).
 *
 * `plumb check` (without --review) runs only the shape floor + diff_sha256 — the
 * LLM semantic review does not run locally. So this banner must NEVER reuse the
 * gate's APPROVE/REVIEW/REWORK vocabulary (that reads as the final verdict when
 * only one dimension was checked). It reports strictly the shape dimension and
 * points at where the full verdict comes from.
 */
export function renderPreflight(shape: ShapeResult): string {
  const lines: string[] = [];
  lines.push(`## 🔎 plumbline shape pre-flight: ${shape.pass ? "PASS" : "FAIL"}`);
  lines.push("");
  if (shape.pass) {
    lines.push(
      "> **Shape floor + diff_sha256 verified locally — this is NOT the full gate verdict.** " +
        "The LLM semantic review runs in CI. Run `plumb check --review` to get the full verdict (shape + semantic) locally.",
    );
  } else {
    lines.push(
      "> **Shape floor / diff_sha256 problems below — fix before pushing.** " +
        "The semantic review (run in CI, or locally via `plumb check --review`) is a separate dimension not checked here.",
    );
  }
  lines.push("");
  lines.push(`**Shape gate:** ${shape.pass ? "pass" : "FAIL"}`);
  for (const e of shape.errors) lines.push(`- ❌ ${e}`);
  for (const w of shape.warnings) lines.push(`- ⚠️ ${w}`);
  return lines.join("\n");
}
