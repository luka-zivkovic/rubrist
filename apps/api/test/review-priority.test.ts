import { describe, expect, it } from "vitest";
import { demoProject, demoSkill } from "@rubrist/db";
import { CreateReviewQueueInputSchema } from "@rubrist/shared";
import { suggestReviewBatch, type ReviewCandidate } from "../src/lib/review-priority.js";
import { DemoRepository } from "../src/repository.js";
import { createApp } from "../src/app.js";
import type { DemoRepositoryStore } from "../src/repository/demo-store.js";

const candidates = (count: number, verdict: string): ReviewCandidate[] => Array.from({ length: count }, (_, index) => ({
  caseId: `${verdict}_${index}`, judgeRunId: `run_${verdict}_${index}`, verdict, createdAt: new Date(1_000 + index).toISOString()
}));
describe("operational review suggestions", () => {
  it("mixes flags and ambiguous cases, reserves passing checks, and reproduces a seeded draw", () => {
    const rows = [...candidates(20, "fail"), ...candidates(20, "ambiguous"), ...candidates(20, "pass")];
    const batch = suggestReviewBatch(rows, "version", "criterion", 10, "seed");
    expect(batch.items.map(item => item.reason)).toEqual(["flagged", "ambiguous", "flagged", "ambiguous", "flagged", "ambiguous", "flagged", "ambiguous", "spot_check", "spot_check"]);
    expect(new Set(batch.items.map(item => item.caseId)).size).toBe(10);
    expect(suggestReviewBatch([...rows].reverse(), "version", "criterion", 10, "seed")).toEqual(batch);
    expect(suggestReviewBatch(rows, "version", "criterion", 10, "another").items).not.toEqual(batch.items);
  });
  it("fills a sparse bucket without inventing cases and reports the recent-window cap", () => {
    expect(suggestReviewBatch(candidates(3, "pass"), "v", "c", 10).items).toHaveLength(3);
    expect(suggestReviewBatch(candidates(20, "fail"), "v", "c", 10).items).toHaveLength(10);
    expect(suggestReviewBatch([], "v", "c", 10)).toMatchObject({ consideredCount: 0, capped: false, items: [] });
    const capped = suggestReviewBatch(candidates(1001, "pass"), "v", "c", 50);
    expect(capped).toMatchObject({ consideredCount: 1000, capped: true });
    expect(capped.items.some(item => item.caseId === "pass_0")).toBe(false);
  });
  it("requires complete explicit case pins and a named evaluator", () => {
    const input = { name: "Review", caseIds: ["a", "b"], skillVersionId: "v" };
    expect(CreateReviewQueueInputSchema.safeParse({ ...input, judgeRunIds: { a: "r" } }).success).toBe(false);
    expect(CreateReviewQueueInputSchema.safeParse({ ...input, judgeRunIds: { a: "r", b: "s", extra: "t" } }).success).toBe(false);
    expect(CreateReviewQueueInputSchema.safeParse({ ...input, skillVersionId: undefined, judgeRunIds: { a: "r", b: "s" } }).success).toBe(false);
    expect(CreateReviewQueueInputSchema.safeParse({ ...input, judgeRunIds: { a: "r", b: "s" } }).success).toBe(true);
  });
  it("filters reviewed and pending results, preserves preview pins after a new run, and isolates versions/projects", async () => {
    const repo = new DemoRepository(undefined, { seedVerdicts: false });
    const store = Reflect.get(repo, "store") as DemoRepositoryStore;
    const projectId = demoProject.id;
    const skillVersionId = demoSkill.currentVersion.id;
    await repo.getCurrentSkill(projectId);
    for (let i = 0; i < 4; i++) {
      const { caseId } = await repo.importTrace(projectId, "manual", { sourceTraceId: `priority-${i}`, input: `Q${i}`, output: `A${i}`, metadata: {} }, { ingestionPurpose: "analysis_eligible_manual" });
      await repo.recordJudgeRun({ projectId, caseId, skillVersionId, verdict: { label: i === 0 ? "fail" : i === 1 ? "ambiguous" : "pass", score: 0.5, confidence: 0.9, reason: "Recorded opinion" } });
    }
    const initial = await repo.suggestReviewQueue(projectId, skillVersionId, 10);
    expect(initial.items).toHaveLength(4);
    const pinned = initial.items[0]!;
    const original = store.judgeRuns.find(run => run.id === pinned.judgeRunId)!;
    store.judgeRuns.push({ ...original, id: "newer-run", verdict: "pass", createdAt: new Date(Date.parse(original.createdAt) + 10_000).toISOString() });
    const queue = await repo.createReviewQueue({ projectId, skillVersionId, name: "Pinned preview", caseIds: [pinned.caseId], judgeRunIds: { [pinned.caseId]: pinned.judgeRunId } });
    expect((await repo.getReviewQueueDetail(projectId, queue.id))!.items[0]!.judgeRunId).toBe(pinned.judgeRunId);
    const second = initial.items[1]!;
    const pending = await repo.createReviewQueue({ projectId, skillVersionId, name: "Pending", caseIds: [second.caseId] });
    const third = initial.items[2]!;
    await repo.recordVerdict({ projectId, skillVersionId, caseId: third.caseId, source: "human", payload: { kind: "binary", pass: true, rationale: "Human review" } });
    const next = await repo.suggestReviewQueue(projectId, skillVersionId, 10);
    expect(next.items.map(item => item.caseId)).not.toContain(second.caseId);
    expect(next.items.map(item => item.caseId)).not.toContain(third.caseId);
    expect(next.items.find(item => item.caseId === pinned.caseId)!.judgeRunId).toBe("newer-run");
    await expect(repo.createReviewQueue({ projectId, skillVersionId, name: "Wrong result", caseIds: [pinned.caseId], judgeRunIds: { [pinned.caseId]: second.judgeRunId } })).rejects.toThrow(/No recorded result/);
    await expect(repo.suggestReviewQueue("other-project", skillVersionId, 10)).rejects.toThrow(/project/);
    await expect(repo.suggestReviewQueue(projectId, "other-version", 10)).rejects.toThrow(/project/);
    await repo.closeReviewQueue(projectId, pending.id);
    expect((await repo.suggestReviewQueue(projectId, skillVersionId, 10)).items.map(item => item.caseId)).toContain(second.caseId);
    const app = createApp(repo);
    const response = await app.request(`/api/review-queues/suggestions?skillVersionId=${skillVersionId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Rubrist-Governance-Class")).toBe("ungoverned_legacy");
    expect((await app.request("/api/review-queues/suggestions")).status).toBe(400);
    expect((await app.request(`/api/review-queues/suggestions?skillVersionId=${skillVersionId}&limit=100`)).status).toBe(400);
  });
});
