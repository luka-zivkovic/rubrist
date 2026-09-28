import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedCriterion, seedSkill } from "./pg-smoke-support.js";

runPgSmoke("historical review case selection", () => {
  it("reads only the exact queue criterion, retains displayed-version review attribution, and leaves other tasks pending", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("historical_review");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
      await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
      await seedSkill(pool);
      await seedCriterion(pool, "other");
      await pool.query(`insert into skills (id, project_id, name, description, status, criterion_id)
        values ('skill_other', 'proj_test', 'Other criterion', '', 'draft', 'criterion_other')`);
      for (const [id, skill, version, criterion] of [
        ["skillv_new", "skill_test", "0.2.0", "criterionv_test"],
        ["skillv_other", "skill_other", "0.1.0", "criterionv_other"]
      ]) {
        await pool.query(`insert into skill_versions (id,skill_id,project_id,version,status,rubric_markdown,prompt,output_schema,execution_binding,criterion_version_id)
          select $1,$2,project_id,$3,status,rubric_markdown,prompt,output_schema,execution_binding,$4 from skill_versions where id='skillv_test'`, [id, skill, version, criterion]);
      }
      const { caseId } = await repo.importTrace("proj_test", "manual", { sourceTraceId: "historical", input: "Evidence", output: "Claim", metadata: {} }, { ingestionPurpose: "analysis_eligible_manual" });
      const first = await repo.recordJudgeRun({ projectId: "proj_test", caseId, skillVersionId: "skillv_test", verdict: { label: "fail", score: 0.1, confidence: 0.9, reason: "Missing support" } });
      await repo.recordJudgeRun({ projectId: "proj_test", caseId, skillVersionId: "skillv_other", verdict: { label: "pass", score: 0.9, confidence: 0.9, reason: "Different criterion" } });
      const queue = await repo.createReviewQueue({ projectId: "proj_test", name: "Historical review", caseIds: [caseId], criterionVersionId: "criterionv_test" });
      const otherQueue = await repo.createReviewQueue({ projectId: "proj_test", name: "Other review", caseIds: [caseId], criterionVersionId: "criterionv_other" });
      expect(await repo.getCaseDetail("proj_test", caseId, "skillv_new")).toBeNull();
      const detail = await repo.getCaseDetail("proj_test", caseId, undefined, "criterionv_test");
      expect(detail?.judgeRun.id).toBe(first.id);
      expect(detail?.exception.criterionVersionId).toBe("criterionv_test");
      expect(detail?.verdictHistory.every((verdict) => verdict.skillVersionId === "skillv_test")).toBe(true);
      expect(await repo.getCaseDetail("proj_test", caseId, "skillv_other", "criterionv_test")).toBeNull();
      expect(await repo.getCaseDetail("proj_test", caseId, undefined, "criterionv_missing")).toBeNull();
      expect(await repo.getCaseDetail("foreign_project", caseId, undefined, "criterionv_test")).toBeNull();
      const review = await repo.recordVerdict({ projectId: "proj_test", caseId, skillVersionId: detail!.judgeRun.skillVersionId, source: "human", payload: { kind: "binary", pass: false, rationale: "Reviewed evidence" } });
      expect(review.skillVersionId).toBe("skillv_test");
      expect((await repo.getReviewQueueDetail("proj_test", queue.id))?.queue.completedCount).toBe(1);
      expect((await repo.getReviewQueueDetail("proj_test", otherQueue.id))?.queue.pendingCount).toBe(1);
      expect((await pool.query(`select count(*)::int as count from judge_runs where case_id=$1`, [caseId])).rows[0].count).toBe(2);
    } finally {
      await cleanup();
    }
  });
});
