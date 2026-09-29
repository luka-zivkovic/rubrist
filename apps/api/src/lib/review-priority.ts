import { createHash, randomUUID } from "node:crypto";
import type { ReviewQueueSuggestion } from "@rubrist/shared";
export const REVIEW_CANDIDATE_LIMIT = 1000;
export type ReviewCandidate = { caseId: string; judgeRunId: string; verdict: string; createdAt: string };

/** Operational triage only: never a representative draw or calibrated uncertainty. */
export function suggestReviewBatch(candidates: ReviewCandidate[], skillVersionId: string, criterionVersionId: string, limit: number, seed: string = randomUUID()): ReviewQueueSuggestion {
  const recent = [...candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.judgeRunId.localeCompare(a.judgeRunId));
  const considered = recent.slice(0, REVIEW_CANDIDATE_LIMIT);
  const rank = (item: ReviewCandidate) => createHash("sha256").update(`${seed}\0${item.caseId}\0${item.judgeRunId}`).digest("hex");
  const shuffled = considered.map(item => ({ item, rank: rank(item) })).sort((a, b) => a.rank.localeCompare(b.rank) || a.item.caseId.localeCompare(b.item.caseId)).map(entry => entry.item);
  const fails = shuffled.filter(item => item.verdict === "fail");
  const ambiguous = shuffled.filter(item => item.verdict !== "fail" && item.verdict !== "pass");
  const passes = shuffled.filter(item => item.verdict === "pass");
  const budget = Math.min(50, Math.max(1, Math.floor(limit)));
  const spots = passes.splice(0, Math.ceil(budget / 5));
  const selected: ReviewCandidate[] = [];
  while (selected.length < budget - spots.length && (fails.length || ambiguous.length)) {
    if (fails.length) selected.push(fails.shift()!);
    if (selected.length < budget - spots.length && ambiguous.length) selected.push(ambiguous.shift()!);
  }
  selected.push(...spots);
  selected.push(...[...fails, ...ambiguous, ...passes].slice(0, budget - selected.length));
  return {
    method: "review-priority/v1", skillVersionId, criterionVersionId, seed,
    consideredCount: considered.length, capped: recent.length > REVIEW_CANDIDATE_LIMIT,
    items: selected.map(item => ({ caseId: item.caseId, judgeRunId: item.judgeRunId,
      reason: item.verdict === "pass" ? "spot_check" : item.verdict === "fail" ? "flagged" : "ambiguous" }))
  };
}
