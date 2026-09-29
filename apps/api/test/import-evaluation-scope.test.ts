import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";
import { runExistingCaseBackfill } from "../src/workers/gate.js";
import { scheduleImportedCaseJudging } from "../src/workers/import-judging.js";
import { CapturingQueue } from "./app-test-support.js";

describe("automatic import evaluation scope", () => {
  it("finds saved scope behind more than 100 unrelated runs", async () => {
    const repository = new DemoRepository();
    const queue = new CapturingQueue();
    const projectId = "proj_langsmith_support";
    const skillVersionId = "skillv_1_2_0";
    const [caseId] = await repository.listCaseIdsForProject(projectId, 1);
    const saved = await repository.createEvalRun({ projectId, skillVersionId, trigger: "backfill", items: [{ caseId: caseId! }] });
    for (let i = 0; i < 105; i++) await repository.createEvalRun({ projectId, skillVersionId, trigger: "manual", items: [{ caseId: caseId! }] });
    const scheduled = await scheduleImportedCaseJudging(repository, queue, { projectId, skillVersionId, caseIds: [caseId!] });
    expect(scheduled.evalRunIds).toEqual([saved.id]);
    expect(scheduled.backfillRunId).toBe(saved.id);
    const app = createApp(repository, { queue });
    const listed = await app.request(`/api/eval-runs?limit=1&skillVersionId=${skillVersionId}&purpose=first_assessment`);
    await expect(listed.json()).resolves.toMatchObject({ runs: [{ id: saved.id }] });
    const continued = await app.request(`/api/skills/skill_support_quality/versions/${skillVersionId}/backfill`, { method: "POST" });
    await expect(continued.json()).resolves.toMatchObject({ run: { id: saved.id, totalItems: 1 } });
    const explicit = await runExistingCaseBackfill(repository, projectId, skillVersionId, queue);
    expect(explicit?.run.id).toBe(saved.id);
    expect(explicit?.run.totalItems).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    const empty = await scheduleImportedCaseJudging(repository, queue, { projectId, skillVersionId, caseIds: [] });
    expect(empty).toEqual({ scheduledCaseCount: 0, evalRunIds: [], backfillRunId: null, dispatchPending: false });
    expect(queue.jobs).toHaveLength(1);
  });

  it("resumes an undispatched import without creating a historical backfill", async () => {
    const queue = new CapturingQueue();
    const repository = new DemoRepository();
    const [caseId] = await repository.listCaseIdsForProject("proj_langsmith_support", 1);
    const run = await repository.createEvalRun({
      projectId: "proj_langsmith_support",
      skillVersionId: "skillv_1_2_0",
      trigger: "api_batch",
      items: [{ caseId: caseId! }]
    });
    const abandonedToken = "abandoned-first-result-dispatch";
    await expect(repository.claimEvalRunDispatch({
      projectId: "proj_langsmith_support",
      evalRunId: run.id,
      dispatchToken: abandonedToken
    })).resolves.toMatchObject({ state: "claimed" });
    const localApp = createApp(repository, { queue });
    const path = "/api/skills/skill_support_quality/versions/skillv_1_2_0/backfill";

    const busy = await localApp.request(path, { method: "POST" });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("300");
    await expect(busy.json()).resolves.toMatchObject({
      error: expect.stringContaining("not durably queued"),
      run: { id: run.id, status: "pending" }
    });
    expect(queue.jobs).toHaveLength(0);

    await repository.releaseEvalRunDispatch({
      projectId: "proj_langsmith_support",
      evalRunId: run.id,
      dispatchToken: abandonedToken
    });
    const recovered = await localApp.request(path, { method: "POST" });
    expect(recovered.status).toBe(202);
    expect(queue.jobs.filter((job) => job.name === "eval.run")).toHaveLength(1);
  });

});
