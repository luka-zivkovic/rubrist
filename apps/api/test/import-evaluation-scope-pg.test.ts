import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { PgRepository } from "../src/repository.pg.js";
import { scheduleImportedCaseJudging } from "../src/workers/import-judging.js";
import { runExistingCaseBackfill } from "../src/workers/gate.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { CapturingQueue, runPgSmoke, seedSkill } from "./pg-smoke-support.js";

runPgSmoke("automatic import evaluation scope", () => {
  it("keeps first imports scoped, retries unique and saved historical coverage discoverable", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("import_scope");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      const queue = new CapturingQueue();
      await pool.query(`insert into organizations (id,name) values ('org_test','Test')`);
      await pool.query(`insert into projects (id,organization_id,name,trace_provider) values ('proj_test','org_test','Test','manual')`);
      await seedSkill(pool);
      await pool.query(`update skill_versions set status='approved', approved_at=now() where id='skillv_test'`);
      const projectId = "proj_test";
      const skillVersionId = "skillv_test";
      const importCase = (sourceTraceId: string) => repo.importTrace(projectId, "manual", {
        sourceTraceId, input: { question: sourceTraceId }, output: "answer", metadata: {}
      }, { ingestionPurpose: "analysis_eligible_manual" });
      const historical = await importCase("historical");
      const first = await importCase("first-new");
      const second = await importCase("second-new");
      await Promise.all([
        scheduleImportedCaseJudging(repo, queue, { projectId, skillVersionId, caseIds: [first.caseId, first.caseId] }),
        scheduleImportedCaseJudging(repo, queue, { projectId, skillVersionId, caseIds: [first.caseId, second.caseId] })
      ]);
      const runs = await repo.listEvalRuns(projectId, { skillVersionId });
      expect(runs).toHaveLength(2);
      expect(runs.every(run => run.trigger === "api_batch" && run.totalItems === 1)).toBe(true);
      const details = await Promise.all(runs.map(run => repo.getEvalRunDetail(projectId, run.id)));
      expect(details.flatMap(run => run!.items.map(item => item.caseId)).sort()).toEqual([first.caseId, second.caseId].sort());
      expect(queue.jobs).toHaveLength(2);
      const backfill = await repo.createEvalRun({ projectId, skillVersionId, trigger: "backfill", items: [{ caseId: historical.caseId }] });
      for (let i = 0; i < 105; i++) await repo.createEvalRun({ projectId, skillVersionId, trigger: "manual", items: [{ caseId: historical.caseId }] });
      const covered = await scheduleImportedCaseJudging(repo, queue, { projectId, skillVersionId, caseIds: [historical.caseId] });
      expect(covered.evalRunIds).toEqual([backfill.id]);
      expect(covered.backfillRunId).toBe(backfill.id);
      await repo.createEvalRun({ projectId, skillVersionId, trigger: "api_batch", items: [] });
      const listed = await repo.listEvalRuns(projectId, { skillVersionId, purpose: "first_assessment", limit: 1 });
      expect(listed.map(run => run.id)).toEqual([backfill.id]);
      const resumed = await runExistingCaseBackfill(repo, projectId, skillVersionId, queue);
      expect(resumed?.run.id).toBe(backfill.id);
      expect(resumed?.run.totalItems).toBe(1);
      expect(queue.jobs).toHaveLength(3);
    } finally { await cleanup(); }
  }, 60_000);
});
