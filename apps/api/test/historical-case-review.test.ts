import { demoProject, demoSkill } from "@rubrist/db";
import type { ExceptionDetail } from "@rubrist/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";
import type { DemoRepositoryStore } from "../src/repository/demo-store.js";

function fixture() {
  const repository = new DemoRepository();
  const store = Reflect.get(repository, "store") as DemoRepositoryStore;
  const criterionVersionId = store.skillVersionCriteria.get(demoSkill.currentVersion.id)!;
  store.criteria.push({ ...store.criteria[0]!, id: "criterion_other", stableKey: "other" });
  store.skillVersionCriteria.set("skillv_old", criterionVersionId);
  store.skillVersionCriteria.set("skillv_other", "criterionv_other");
  store.judgeRuns.push(...[
    { id: "judge_old", skillVersionId: "skillv_old", createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "judge_other", skillVersionId: "skillv_other", createdAt: "2026-09-02T00:00:00.000Z" }
  ].map((run) => ({ ...run, projectId: demoProject.id, caseId: "case_historical", verdict: "fail" as const, score: 0.1, reasoning: "Recorded evidence" })));
  store.traces.set("case_historical", { id: "trace_historical", input: "old evidence", output: "answer", metadata: {} });
  return { repository, store, criterionVersionId, app: createApp(repository) };
}

describe("historical case review", () => {
  it("reads an older result for the queue's exact criterion and attributes its review to that result", async () => {
    const { app, repository, store, criterionVersionId } = fixture();
    const queue = await repository.createReviewQueue({ projectId: demoProject.id, name: "Historical examples", caseIds: ["case_historical"], criterionVersionId });
    const missingCurrent = await app.request(`/api/cases/case_historical?skillVersionId=${demoSkill.currentVersion.id}`);
    expect(missingCurrent.status).toBe(404);
    const response = await app.request(`/api/cases/case_historical?criterionVersionId=${criterionVersionId}`);
    expect(response.status).toBe(200);
    const detail = await response.json() as ExceptionDetail;
    expect(detail.judgeRun.id).toBe("judge_old");
    expect(detail.exception.criterionVersionId).toBe(criterionVersionId);
    const review = await app.request("/api/cases/case_historical/verdicts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ skillVersionId: detail.judgeRun.skillVersionId, payload: { kind: "binary", pass: false, rationale: "Reviewed old evidence" } })
    });
    expect(review.status).toBe(201);
    expect(await review.json()).toMatchObject({ verdict: { skillVersionId: "skillv_old", source: "human" } });
    expect((await repository.getReviewQueueDetail(demoProject.id, queue.id))?.queue.completedCount).toBe(1);
    expect(store.judgeRuns).toHaveLength(2);
  });

  it("never substitutes another criterion, and represents missing scoped evidence explicitly", async () => {
    const { app } = fixture();
    const response = await app.request("/api/cases/case_historical?criterionVersionId=criterionv_missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "case_evaluation_unavailable", error: "No recorded evaluator result is available for this case and criterion version." });
  });

  it("requires both selectors to match when an evaluator and criterion are named", async () => {
    const { app, criterionVersionId } = fixture();
    const response = await app.request(`/api/cases/case_historical?criterionVersionId=${criterionVersionId}&skillVersionId=skillv_other`);
    expect(response.status).toBe(404);
  });
});
