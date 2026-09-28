import { randomUUID } from "node:crypto";
import { demoProject } from "@rubrist/db";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";

describe("saved task API evidence identity", () => {
  it("requires available selected evidence and round-trips exact run and task attribution", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const skill = await repository.getCurrentSkill(demoProject.id);
    const versionId = skill.currentVersion.id;
    const { caseId } = await repository.importTrace(demoProject.id, "manual", { sourceTraceId: "pin-api", input: "Evidence", output: "Claim", metadata: {} }, { ingestionPurpose: "analysis_eligible_manual" });
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/api/review-queues", { name: "Missing result", caseIds: [caseId], skillVersionId: versionId })).status).toBe(400);
    const run = await repository.recordJudgeRun({ projectId: demoProject.id, caseId, skillVersionId: versionId, verdict: { label: "fail", score: 0.1, confidence: 0.9, reason: "Unsupported" } });
    const created = await post("/api/review-queues", { name: "Pinned", caseIds: [caseId], skillVersionId: versionId });
    expect(created.status).toBe(201);
    const { queue } = await created.json() as any;
    const { items } = await (await app.request(`/api/review-queues/${queue.id}`)).json() as any;
    expect(items[0]).toMatchObject({ skillVersionId: versionId, judgeRunId: run.id });
    const exact = await app.request(`/api/cases/${caseId}?judgeRunId=${run.id}`);
    expect(exact.status).toBe(200);
    expect((await exact.json() as any).judgeRun.id).toBe(run.id);
    expect((await app.request(`/api/cases/${caseId}?judgeRunId=missing`)).status).toBe(404);
    const body = { payload: { kind: "binary", pass: false, rationale: "Reviewed evidence" }, reviewContext: { queueItemId: items[0].id, judgeRunId: run.id, submissionId: randomUUID() } };
    expect((await post(`/api/cases/${caseId}/verdicts`, { ...body, reviewContext: { queueItemId: items[0].id } })).status).toBe(400);
    expect((await post(`/api/cases/${caseId}/verdicts`, { ...body, reviewContext: { ...body.reviewContext, judgeRunId: "missing" } })).status).toBe(409);
    const response = await post(`/api/cases/${caseId}/verdicts`, body);
    expect(response.status).toBe(201);
    const saved = await response.json() as any;
    expect(saved.verdict).toMatchObject({ skillVersionId: versionId, reviewContext: body.reviewContext });
    const retry = await post(`/api/cases/${caseId}/verdicts`, body);
    expect((await retry.json() as any).verdict.id).toBe(saved.verdict.id);
    expect((await repository.getReviewQueueDetail(demoProject.id, queue.id))!.queue.completedCount).toBe(1);
    await repository.closeReviewQueue(demoProject.id, queue.id);
    expect((await post(`/api/cases/${caseId}/verdicts`, { ...body, reviewContext: { ...body.reviewContext, submissionId: randomUUID() } })).status).toBe(409);
  });
});
