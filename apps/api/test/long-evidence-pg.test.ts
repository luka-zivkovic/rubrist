import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { MockJudgeProvider } from "@rubrist/audit/runtime";
import { PgRepository } from "../src/repository.pg.js";
import { processJudgeRunJob } from "../src/workers/judge.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedSkill } from "./pg-smoke-support.js";

runPgSmoke("long retained evidence", () => {
  it("preserves policy and tool results through storage, judging and review with redaction intact", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("long_evidence");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id,name) values ('org_test','Test')`);
      await pool.query(`insert into projects (id,organization_id,name,trace_provider) values ('proj_test','org_test','Test','manual')`);
      await seedSkill(pool);
      const input = { messages: [
        { role: "system", content: "Policy ".repeat(1700) + "Never change destination." },
        { role: "tool", content: "Observation ".repeat(1500) + "Payment remains pending." }
      ], api_key: "secret", hidden: "excluded" };
      const output = "Recorded answer ".repeat(700) + "End of answer.";
      const imported = await repo.importTrace("proj_test", "manual", { sourceTraceId: "long", input, output, metadata: {} }, {
        ingestionPurpose: "analysis_eligible_manual", redactionConfig: { excludedPaths: ["input.hidden"] }
      });
      const expected = { input: { ...input, api_key: "[REDACTED]", hidden: "[EXCLUDED]" }, output, metadata: {} };
      const stored = (await pool.query(`select normalized_payload from cases where id=$1`, [imported.caseId])).rows[0].normalized_payload;
      expect(stored).toEqual(expected);
      const context = await repo.loadJudgeRunContext({ projectId: "proj_test", caseId: imported.caseId, skillVersionId: "skillv_test" });
      expect(context.trace).toMatchObject(expected);
      await processJudgeRunJob(repo, { projectId: "proj_test", caseId: imported.caseId, skillVersionId: "skillv_test" }, new MockJudgeProvider());
      expect((await repo.getCaseDetail("proj_test", imported.caseId))?.trace).toMatchObject(expected);
      const clipped = await repo.importTrace("proj_test", "manual", { sourceTraceId: "explicit-limit", input: { text: "abc😀tail" }, output: "ok", metadata: {} }, {
        ingestionPurpose: "analysis_eligible_manual", redactionConfig: { maxStringChars: 4 }
      });
      const clippedContext = await repo.loadJudgeRunContext({ projectId: "proj_test", caseId: clipped.caseId, skillVersionId: "skillv_test" });
      expect(clippedContext.trace.input).toEqual({ text: "abc…[TRUNCATED]" });
    } finally { await cleanup(); }
  }, 60_000);
});
