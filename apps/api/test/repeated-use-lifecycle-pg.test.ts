import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { MockJudgeProvider } from "@rubrist/audit/runtime";
import { MinimumVerdictOutputSchema } from "@rubrist/shared";
import { PgRepository } from "../src/repository.pg.js";
import { runEvalRunInline } from "../src/workers/eval-run.js";
import { scheduleImportedCaseJudging } from "../src/workers/import-judging.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { FailingOnceQueue, runPgSmoke, seedSkill } from "./pg-smoke-support.js";
import { bindingInput, MOCK_BINDING } from "./fixtures/execution-binding.js";

// Synthetic reviewer actions live only in this disposable test schema. Mock
// verdicts exercise storage/execution, not model accuracy or calibration.
runPgSmoke("repeated-use lifecycle", () => {
  it("preserves old reviews across three import batches, retries, evaluator changes and selective reassessment", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("repeated_use");
    try {
      await runMigrations(pool);
      await pool.query(`insert into organizations(id,name) values('org_test','Test');
        insert into projects(id,organization_id,name,trace_provider) values('proj_test','org_test','Test','manual')`);
      await seedSkill(pool);
      await pool.query(`update skill_versions set status='approved',approved_at=now() where id='skillv_test'`);
      const projectId = "proj_test", originalVersion = "skillv_test";
      const policy = "Supplied policy. ".repeat(400) + "Final condition retained.";
      const tool = "Recorded observation. ".repeat(300) + "Final observation retained.";
      const calls: string[] = [];
      class CountingProvider extends MockJudgeProvider {
        override async judgeStructured(input: Parameters<MockJudgeProvider["judgeStructured"]>[0]) {
          expect(input.trace.input).toMatchObject({ policy, api_key: "[REDACTED]" });
          expect(input.trace.steps?.[0]?.output).toBe(tool);
          calls.push(input.prompt.id);
          return super.judgeStructured(input);
        }
      }
      const provider = new CountingProvider();
      const queue = new FailingOnceQueue();
      let repo = new PgRepository(pool);
      const importBatch = async (batch: number) => Promise.all(Array.from({ length: 4 }, (_, i) => repo.importTrace(projectId, "manual", {
        sourceTraceId: `batch-${batch}-case-${i}`, input: { policy, caseNumber: batch * 4 + i, api_key: "synthetic-secret" },
        output: ["Helpful response.", "Wrong response.", "Minor omission.", "Unclear response."][i], metadata: {},
        steps: [{ name: "lookup", input: "request", output: tool }]
      }, { ingestionPurpose: "analysis_eligible_manual" })));
      const schedule = (version: string, caseIds: string[]) => scheduleImportedCaseJudging(repo, queue, { projectId, skillVersionId: version, caseIds });
      const finish = async (runIds: string[]) => {
        for (const id of new Set(runIds)) {
          await runEvalRunInline(repo, projectId, id, provider);
          expect((await repo.getEvalRun(projectId, id))?.status).toBe("completed");
          // Redelivery after completion must not spend again.
          const before = calls.length;
          await runEvalRunInline(repo, projectId, id, provider);
          expect(calls).toHaveLength(before);
        }
      };
      const first = await importBatch(0);
      const firstIds = first.map(row => row.caseId);
      await expect(schedule(originalVersion, firstIds)).rejects.toThrow("Queue unavailable");
      repo = new PgRepository(pool); // A fresh repository instance resumes from persisted state.
      const [retry, concurrent] = await Promise.all([schedule(originalVersion, firstIds), schedule(originalVersion, [...firstIds, firstIds[0]!])]);
      await finish([...retry.evalRunIds, ...concurrent.evalRunIds]);
      expect(calls).toHaveLength(4);
      expect(queue.jobs.filter(job => job.name === "eval.run")).toHaveLength(4);
      const replay = await importBatch(0);
      expect(replay.map(row => row.caseId)).toEqual(firstIds);
      expect((await schedule(originalVersion, firstIds)).evalRunIds).toEqual([]);
      expect(calls).toHaveLength(4);

      const originalRuns = (await pool.query(`select * from judge_runs where skill_version_id=$1 order by id`, [originalVersion])).rows;
      const suggested = await repo.suggestReviewQueue(projectId, originalVersion, 4);
      expect(suggested.items).toHaveLength(4);
      const saved = await repo.createReviewQueue({ projectId, skillVersionId: originalVersion, name: "Synthetic first review",
        caseIds: suggested.items.map(item => item.caseId),
        judgeRunIds: Object.fromEntries(suggested.items.map(item => [item.caseId, item.judgeRunId])) });
      const initialQueue = (await repo.getReviewQueueDetail(projectId, saved.id))!;
      const task = initialQueue.items.find(item => item.caseId === firstIds[2])!;
      const submission = { projectId, caseId: task.caseId, source: "human" as const,
        payload: { kind: "binary" as const, pass: false, rationale: "Synthetic reviewer fixture, not human truth." },
        reviewContext: { queueItemId: task.id, judgeRunId: task.judgeRunId!, submissionId: randomUUID() } };
      const [review, duplicate] = await Promise.all([repo.recordVerdict(submission), repo.recordVerdict(submission)]);
      expect(review.id).toBe(duplicate.id);
      expect((await repo.getReviewQueueDetail(projectId, saved.id))!.queue).toMatchObject({ completedCount: 1, pendingCount: 3 });
      const corrected = await repo.recordVerdict({ ...submission, payload: { ...submission.payload, pass: true },
        reviewContext: { ...submission.reviewContext, submissionId: randomUUID() } });
      expect(corrected.id).not.toBe(review.id);
      const history = (await repo.getCaseDetail(projectId, task.caseId, originalVersion, task.criterionVersionId, task.judgeRunId!))!.verdictHistory;
      expect(history.filter(row => row.reviewContext?.queueItemId === task.id).map(row => row.id).sort()).toEqual([review.id, corrected.id].sort());

      const { version, regressionRun } = await repo.createSkillVersion("skill_test", {
        rubricMarkdown: "Fail borderline responses.", prompt: "Fail borderline responses.",
        executionBinding: bindingInput(MOCK_BINDING), outputSchema: MinimumVerdictOutputSchema,
        verdictKind: "binary", timeScope: "new"
      }, { projectId });
      expect(regressionRun.compared).toBe(0); // Empty reference check is not validation.
      expect((await repo.getCurrentSkillForCriterion(projectId, "criterion_test")).currentVersion.id).toBe(version.id);
      expect(await repo.listEvalRuns(projectId, { skillVersionId: version.id })).toHaveLength(0);
      for (const batch of [1, 2]) {
        repo = new PgRepository(pool);
        const imported = await importBatch(batch);
        const scheduled = await schedule(version.id, imported.map(row => row.caseId));
        expect(scheduled.backfillRunId).toBeNull();
        const details = await Promise.all(scheduled.evalRunIds.map(id => repo.getEvalRunDetail(projectId, id)));
        expect(details.flatMap(detail => detail!.items.map(item => item.caseId)).sort()).toEqual(imported.map(row => row.caseId).sort());
        await finish(scheduled.evalRunIds);
      }
      expect(calls.filter(id => id === originalVersion)).toHaveLength(4);
      expect(calls.filter(id => id === version.id)).toHaveLength(8);
      await expect(schedule(originalVersion, firstIds)).rejects.toThrow(/current runnable/);
      const selected = await schedule(version.id, firstIds.slice(0, 3));
      await finish(selected.evalRunIds);
      expect(calls).toHaveLength(15);
      const reassessed = (await repo.getCaseDetail(projectId, task.caseId, version.id))!;
      expect(reassessed.judgeRun.verdict).toBe("fail");
      expect((await pool.query(`select * from judge_runs where skill_version_id=$1 order by id`, [originalVersion])).rows).toEqual(originalRuns);
      const finalQueue = (await repo.getReviewQueueDetail(projectId, saved.id))!;
      expect(finalQueue.items.map(item => [item.id, item.skillVersionId, item.judgeRunId])).toEqual(initialQueue.items.map(item => [item.id, item.skillVersionId, item.judgeRunId]));
      expect(finalQueue.queue).toMatchObject({ completedCount: 1, pendingCount: 3 });
      const suggestions = await repo.suggestReviewQueue(projectId, version.id, 11);
      expect(suggestions.items).toHaveLength(11);
      // Old-version reviews do not hide the newly assessed result.
      expect(suggestions.items.find(item => item.caseId === task.caseId)?.judgeRunId).toBe(reassessed.judgeRun.id);
      const oldDetail = (await repo.getCaseDetail(projectId, task.caseId, originalVersion, task.criterionVersionId, task.judgeRunId!))!;
      expect(oldDetail.trace.input).toMatchObject({ policy, api_key: "[REDACTED]" });
      expect(oldDetail.judgeRun.id).toBe(task.judgeRunId);
      expect(oldDetail.judgeRun.verdict).toBe("pass");
      // Case history legitimately grows with the new evaluator opinion; every
      // previously recorded entry, including both reviews, stays unchanged.
      expect(history.map(entry => oldDetail.verdictHistory.find(row => row.id === entry.id))).toEqual(history);
      expect((await pool.query(`select count(*)::int as count from cases where project_id=$1`, [projectId])).rows[0].count).toBe(12);
    } finally { await cleanup(); }
  }, 120_000);
});
