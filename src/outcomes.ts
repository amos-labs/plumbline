import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const identity = { repository: z.string().min(1), pr: z.number().int().positive(), head: sha };
const finding = z.object({ id: z.string(), description: z.string() });
const record = z.discriminatedUnion("schema", [
  z.object({ schema: z.literal("plumbline.gate-result.v1"), ...identity,
    phase: z.string(), source: z.enum(["ci", "shadow"]), reviewer_verdict: z.string().optional(),
    audit: z.object({ provider: z.string(), model: z.string(), input_sha256: z.string().optional(),
      cached: z.boolean().optional() }).optional(),
    review_ms: z.number().nonnegative().optional(), policy_sha256: z.string(), findings: z.array(finding) }),
  z.object({ schema: z.literal("plumbline.test-proof.v1"), ...identity,
    merged_commit: sha, job_id: z.number(), test_seconds: z.number().nonnegative() }),
  z.object({ schema: z.literal("plumbline.outcome.v1"), ...identity,
    outcome: z.enum(["fixed", "dismissed", "regression"]), finding: z.string().optional(),
    evidence: z.string().min(1) }),
]);

export function summarize(inputs: unknown[]) {
  const records = inputs.map(input => record.parse(input));
  const counts = () => ({ reviews: 0, findings: 0, fixed: 0, dismissed: 0, unlabeled: 0, latency_ms: [] as number[] });
  const models = new Map<string, ReturnType<typeof counts>>();
  const pairs = new Map<string, Map<string, Set<string>>>();
  const dispositions = new Map<string, string>();
  const observed = new Set<string>();
  const attributed = new Set<string>();
  const regressions = new Set<string>();
  const reused = new Map<string, number>();
  let unavailable = 0;
  const key = (r: {repository: string; pr: number; head: string}) => JSON.stringify([r.repository, r.pr, r.head]);
  for (const r of records) {
    if (r.schema === "plumbline.outcome.v1") {
      if (r.outcome === "regression") { regressions.add(key(r)); continue; }
      if (!r.finding) throw new Error("A fixed or dismissed outcome needs a finding ID");
      const id = key(r) + r.finding;
      if (dispositions.has(id) && dispositions.get(id) !== r.outcome) throw new Error("Conflicting outcomes for " + id);
      dispositions.set(id, r.outcome);
    } else if (r.schema === "plumbline.test-proof.v1") {
      reused.set(JSON.stringify([r.repository, r.merged_commit, r.job_id]), r.test_seconds);
    }
  }
  for (const r of records) {
    if (r.schema !== "plumbline.gate-result.v1" || r.phase === "quality") continue;
    if (!r.audit || !r.reviewer_verdict) { unavailable++; continue; }
    const model = r.audit.provider + "/" + r.audit.model;
    const group = models.get(model) ?? counts();
    models.set(model, group);
    group.reviews++;
    if (!r.audit.cached && r.review_ms !== undefined) group.latency_ms.push(r.review_ms);
    for (const f of r.findings) {
      const id = key(r) + f.id;
      observed.add(id);
      if (attributed.has(model + id)) continue;
      attributed.add(model + id);
      group.findings++;
      const status = dispositions.get(id);
      if (status === "fixed") group.fixed++;
      else if (status === "dismissed") group.dismissed++;
      else group.unlabeled++;
    }
    if (!r.audit.input_sha256) continue;
    const id = key(r) + "/" + r.policy_sha256 + "/" + r.audit.input_sha256;
    const pair = pairs.get(id) ?? new Map<string, Set<string>>();
    pairs.set(id, pair);
    const verdicts = pair.get(model) ?? new Set<string>();
    pair.set(model, verdicts.add(r.reviewer_verdict));
  }
  for (const id of dispositions.keys()) if (!observed.has(id)) throw new Error("Unknown annotated finding: " + id);
  return {
    models: Object.fromEntries(Array.from(models, ([name, {latency_ms, ...m}]) => [name, {
      ...m, timed_reviews: latency_ms.length,
      mean_review_ms: latency_ms.length ? Math.round(latency_ms.reduce((a,b) => a+b, 0) / latency_ms.length) : null,
    }])), unevaluated_reviews: unavailable, confirmed_regression_revisions: regressions.size,
    reused_test_minutes: [...reused.values()].reduce((a,b) => a+b, 0) / 60,
    matched_inputs: [...pairs].filter(([, models]) => models.size > 1).map(([input, models]) => ({
      input, verdicts: Object.fromEntries([...models].map(([m, vs]) => [m, [...vs]]))
    })),
  };
}

export function readOutcomes(directory: string): unknown[] {
  const records: unknown[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) records.push(...readOutcomes(file));
    if (entry.isFile() && entry.name.endsWith(".json")) records.push(JSON.parse(readFileSync(file, "utf8")));
  }
  return records;
}
