import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedCriterion, seedSkill } from "./pg-smoke-support.js";

runPgSmoke("exception backlog totals", () => {
  it("counts the full criterion-scoped pinned queue before capping payloads, and replenishes reviewed rows", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("exception_backlog");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query("insert into organizations (id, name) values ('org_test', 'Test')");
      await pool.query("insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test', 'manual')");
      await seedSkill(pool);
      await seedCriterion(pool, "other");
      await pool.query(`insert into skills (id, project_id, name, description, status, criterion_id)
        values ('skill_other', 'proj_test', 'Other', 'Other', 'draft', 'criterion_other')`);
      await pool.query(`insert into skill_versions
        (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, execution_binding, criterion_version_id)
        select 'skillv_other', 'skill_other', project_id, version, status, rubric_markdown, prompt, output_schema, execution_binding, 'criterionv_other'
        from skill_versions where id = 'skillv_test'`);
      const ids: string[] = [];
      for (let index = 0; index < 57; index++) {
        const imported = await repo.importTrace("proj_test", "manual", {
          sourceTraceId: `backlog-${index}`, input: { question: index }, output: { answer: index }, metadata: {}
        }, { ingestionPurpose: "analysis_eligible_manual" });
        ids.push(imported.caseId);
        await pool.query(`insert into judge_runs (id, project_id, case_id, skill_version_id, verdict, score, reasoning, created_at)
          values ($1,'proj_test',$2,'skillv_test','fail',0,'Pinned failure','2026-01-01'::timestamptz + $3 * interval '1 minute')`,
        [`jr_${index}`, imported.caseId, index]);
      }
      // A later passing run does not close an unresolved earlier failure.
      await pool.query(`insert into judge_runs (id,project_id,case_id,skill_version_id,verdict,score,reasoning,created_at)
        values ('later_pass','proj_test',$1,'skillv_test','pass',1,'Later pass','2026-01-02'),
               ('other_failure','proj_test',$2,'skillv_other','fail',0,'Other criterion','2026-01-02')`, [ids[56], ids[0]]);
      // Closing one criterion must not close the other criterion's exception.
      await repo.recordVerdict({ projectId: "proj_test", caseId: ids[0]!, skillVersionId: "skillv_test", source: "human",
        payload: { kind: "binary", pass: false, rationale: "Reviewed primary criterion" } });
      await pool.query(`insert into golden_set_entries
        (id,project_id,case_id,trace_id,agreed_label,reason,source_skill_version_id,criterion_version_id)
        values ('golden_primary','proj_test',$1,'backlog-1','fail','Known failure','skillv_test','criterionv_test'),
               ('golden_other','proj_test',$2,'backlog-2','fail','Other criterion only','skillv_other','criterionv_other')`, [ids[1], ids[2]]);
      const scaffolding = await repo.importTrace("proj_test", "release_evidence", {
        sourceTraceId: "excluded", input: {}, output: {}, metadata: {}
      }, { ingestionPurpose: "release_evidence" });
      await pool.query(`insert into judge_runs (id,project_id,case_id,skill_version_id,verdict,score,reasoning)
        values ('scaffolding','proj_test',$1,'skillv_test','fail',0,'Excluded')`, [scaffolding.caseId]);

      const dashboard = await repo.getDashboardSummary("proj_test", "criterion_test");
      expect(dashboard.exceptionsTotal).toBe(55);
      expect(dashboard.exceptions).toHaveLength(50);
      expect(dashboard.exceptions.map((entry) => entry.id)).toEqual(ids.slice(7).reverse());
      expect(dashboard.exceptions[0]).toMatchObject({ id: ids[56], verdict: "fail", rejudgedSince: { verdict: "pass" } });
      const other = await repo.getDashboardSummary("proj_test", "criterion_other");
      expect(other.exceptionsTotal).toBe(1);
      expect(other.exceptions.map((entry) => entry.id)).toEqual([ids[0]]);

      await repo.recordVerdict({ projectId: "proj_test", caseId: ids[56]!, skillVersionId: "skillv_test", source: "human",
        payload: { kind: "binary", pass: false, rationale: "Review closes pinned failure despite later pass" } });
      const refreshed = await repo.getDashboardSummary("proj_test", "criterion_test");
      expect(refreshed.exceptionsTotal).toBe(54);
      expect(refreshed.exceptions).toHaveLength(50);
      expect(refreshed.exceptions.map((entry) => entry.id)).toContain(ids[6]);
      expect(refreshed.exceptions.map((entry) => entry.id)).not.toContain(ids[56]);
      await repo.recordVerdict({ projectId: "proj_test", caseId: ids[0]!, skillVersionId: "skillv_other", source: "human",
        payload: { kind: "binary", pass: false, rationale: "Reviewed other criterion" } });
      expect(await repo.getDashboardSummary("proj_test", "criterion_other")).toMatchObject({ exceptions: [], exceptionsTotal: 0 });
    } finally {
      await cleanup();
    }
  }, 60_000);
});
