import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedSkill } from "./pg-smoke-support.js";

runPgSmoke("suggested review batches", () => {
  it("isolates versions and projects, skips reviewed/pending/scaffolding, and saves preview pins across newer runs", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("review_priority");
    try {
      await runMigrations(pool);
      await pool.query(`insert into organizations(id,name) values('org_test','Test');
        insert into projects(id,organization_id,name,trace_provider) values('proj_test','org_test','Test','manual'),('other','org_test','Other','manual')`);
      await seedSkill(pool);
      await pool.query(`insert into skill_versions(id,skill_id,project_id,version,status,rubric_markdown,prompt,output_schema,execution_binding,criterion_version_id)
        select 'skillv_other',skill_id,project_id,'0.2.0',status,rubric_markdown,prompt,output_schema,execution_binding,criterion_version_id from skill_versions where id='skillv_test'`);
      const repo = new PgRepository(pool);
      const rows: Array<{ caseId: string; runId: string }> = [];
      for (let i = 0; i < 6; i++) {
        const { caseId } = await repo.importTrace("proj_test", i === 3 ? "release_evidence" : "manual", { sourceTraceId: `priority-${i}`, input: `Q${i}`, output: `A${i}`, metadata: {} }, { ingestionPurpose: i === 3 ? "release_evidence" : "analysis_eligible_manual" });
        const run = await repo.recordJudgeRun({ projectId: "proj_test", caseId, skillVersionId: "skillv_test", verdict: { label: i % 3 === 0 ? "fail" : i % 3 === 1 ? "ambiguous" : "pass", score: 0.5, confidence: 0.9, reason: "Recorded" } });
        rows.push({ caseId, runId: run.id });
      }
      const [target, pending, reviewed, , otherVersion, untouched] = rows as [typeof rows[number], typeof rows[number], typeof rows[number], typeof rows[number], typeof rows[number], typeof rows[number]];
      await repo.createReviewQueue({ projectId: "proj_test", skillVersionId: "skillv_test", name: "Pending", caseIds: [pending.caseId] });
      await repo.recordVerdict({ projectId: "proj_test", skillVersionId: "skillv_test", caseId: reviewed.caseId, source: "human", payload: { kind: "binary", pass: true, rationale: "Reviewed" } });
      // A review of another evaluator does not suppress this evaluator's result.
      await repo.recordVerdict({ projectId: "proj_test", skillVersionId: "skillv_other", caseId: otherVersion.caseId, source: "human", payload: { kind: "binary", pass: true, rationale: "Other version" } });
      const suggestion = await repo.suggestReviewQueue("proj_test", "skillv_test", 10);
      expect(new Set(suggestion.items.map(item => item.caseId))).toEqual(new Set([target.caseId, otherVersion.caseId, untouched.caseId]));
      await expect(repo.suggestReviewQueue("other", "skillv_test", 10)).rejects.toThrow(/project/);
      await expect(repo.suggestReviewQueue("proj_test", "missing", 10)).rejects.toThrow(/project/);
      await pool.query(`insert into judge_runs(id,project_id,case_id,skill_version_id,verdict,score,reasoning,created_at)
        values('newer','proj_test',$1,'skillv_test','pass',1,'Newer',now()+interval '1 second')`, [target.caseId]);
      const queue = await repo.createReviewQueue({ projectId: "proj_test", skillVersionId: "skillv_test", name: "Preview pins", caseIds: [target.caseId], judgeRunIds: { [target.caseId]: target.runId } });
      expect((await repo.getReviewQueueDetail("proj_test", queue.id))!.items[0]!.judgeRunId).toBe(target.runId);
      await expect(repo.createReviewQueue({ projectId: "proj_test", skillVersionId: "skillv_test", name: "Wrong pin", caseIds: [target.caseId], judgeRunIds: { [target.caseId]: untouched.runId } })).rejects.toThrow(/No recorded result/);
      expect((await repo.listReviewQueues("proj_test")).map(item => item.name)).not.toContain("Wrong pin");
      const next = await repo.suggestReviewQueue("proj_test", "skillv_test", 10);
      expect(next.items.find(item => item.caseId === target.caseId)!.judgeRunId).toBe("newer");
      const item = (await repo.getReviewQueueDetail("proj_test", queue.id))!.items[0]!;
      await repo.recordVerdict({ projectId: "proj_test", caseId: target.caseId, source: "human", payload: { kind: "binary", pass: false, rationale: "Old result reviewed" }, reviewContext: { queueItemId: item.id, judgeRunId: target.runId, submissionId: randomUUID() } });
      expect((await repo.suggestReviewQueue("proj_test", "skillv_test", 10)).items.find(item => item.caseId === target.caseId)!.judgeRunId).toBe("newer");
    } finally { await cleanup(); }
  }, 60_000);
});
