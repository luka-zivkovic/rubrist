import { expect, it, vi } from "vitest";
import { runMigrations } from "@rubrist/db";
import { PgRepository } from "../src/repository.pg.js";
import { processJudgeRunJob } from "../src/workers/judge.js";
import { processFeedbackSyncJob, resumeSignedOffFeedback } from "../src/workers/feedback-sync.js";
import { PROVISIONAL_FEEDBACK_HOLD } from "../src/lib/provisional-feedback.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { CapturingQueue, runPgSmoke, seedSkill } from "./pg-smoke-support.js";

runPgSmoke("provisional feedback delivery", () => {
  it("holds an exact unsigned draft, resumes after its sign-off despite lost dispatch, and retries without new judging", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("provisional_feedback");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      const queue = new CapturingQueue();
      await pool.query("insert into organizations (id,name) values ('org_test','Test')");
      await pool.query("insert into projects (id,organization_id,name,trace_provider) values ('proj_test','org_test','Test','langsmith')");
      await seedSkill(pool);
      await pool.query("update skills set is_starter=true where id='skill_test'");
      await pool.query(`insert into skill_versions
        (id,skill_id,project_id,version,status,rubric_markdown,prompt,output_schema,execution_binding,criterion_version_id)
        select 'skillv_new',skill_id,project_id,'0.1.1',status,rubric_markdown,prompt,output_schema,execution_binding,criterion_version_id
        from skill_versions where id='skillv_test'`);
      const integration = await repo.createLangSmithIntegration("proj_test", { apiKey: "ls_test", projectName: "Support" });
      const imported = await repo.importTrace("proj_test", "langsmith", {
        sourceTraceId: "held-feedback", input: { question: "Refund?" }, output: { answer: "Refunds available." }, metadata: {}
      }, { ingestionPurpose: "analysis_eligible_langsmith", sourceIntegrationId: integration.id });
      await processJudgeRunJob(repo, { projectId: "proj_test", caseId: imported.caseId, skillVersionId: "skillv_test" }, undefined, queue);
      const job = queue.jobs[0]!.data as { projectId: string; feedbackSyncJobId: string };
      const write = vi.fn(async (_payload: unknown) => {});
      const writer = vi.fn(() => ({ createFeedback: write }));
      await processFeedbackSyncJob(repo, job, writer);
      await processFeedbackSyncJob(repo, job, writer);
      expect(writer).not.toHaveBeenCalled();
      expect(await repo.listFeedbackSyncJobs({ projectId: "proj_test", limit: 10 })).toMatchObject([
        { status: "blocked", attempts: 0, lastError: PROVISIONAL_FEEDBACK_HOLD }
      ]);
      expect(await resumeSignedOffFeedback(repo, new CapturingQueue())).toBe(0);
      // Approving a later version clears is_starter globally but cannot release this result.
      await repo.signOffSkillVersion("proj_test", "skill_test", "skillv_new", {});
      expect((await repo.getCurrentSkill("proj_test")).isStarter).toBe(false);
      await processFeedbackSyncJob(repo, job, writer);
      expect(writer).not.toHaveBeenCalled();
      expect(await resumeSignedOffFeedback(repo, new CapturingQueue())).toBe(0);

      // Sign-off can race a worker that already read the draft. The recovery
      // query sees the approval even when parking happened after sign-off.
      const unsigned = await repo.getSkillVersion("proj_test", "skillv_test");
      vi.spyOn(repo, "getSkillVersion").mockImplementationOnce(async () => {
        await repo.signOffSkillVersion("proj_test", "skill_test", "skillv_test", {});
        return unsigned;
      });
      await processFeedbackSyncJob(repo, job, writer);
      expect(writer).not.toHaveBeenCalled();
      expect(await repo.listSignedOffFeedbackSyncJobs(100)).toEqual([job]);
      const unavailable = new CapturingQueue();
      unavailable.send = vi.fn(async () => null) as unknown as typeof unavailable.send;
      expect(await resumeSignedOffFeedback(repo, unavailable)).toBe(0);
      expect(await repo.listSignedOffFeedbackSyncJobs(100)).toEqual([job]);
      const broken = new CapturingQueue();
      broken.send = vi.fn(async () => { throw new Error("Simulated queue outage"); });
      expect(await resumeSignedOffFeedback(repo, broken)).toBe(0);
      expect(await repo.listSignedOffFeedbackSyncJobs(100)).toEqual([job]);
      const recoveredQueue = new CapturingQueue();
      expect(await resumeSignedOffFeedback(new PgRepository(pool), recoveredQueue)).toBe(1);
      expect(recoveredQueue.jobs[0]).toMatchObject({ name: "feedback.sync", data: job });
      // Successful enqueue still leaves the durable row recoverable until delivery.
      expect(await repo.listSignedOffFeedbackSyncJobs(100)).toEqual([job]);
      write.mockRejectedValueOnce(new Error("Temporary provider outage"));
      await expect(processFeedbackSyncJob(repo, job, writer)).rejects.toThrow("Temporary provider outage");
      await processFeedbackSyncJob(repo, job, writer);
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls.map(([payload]) => (payload as { feedbackId: string }).feedbackId))
        .toEqual([job.feedbackSyncJobId, job.feedbackSyncJobId]);
      expect(await repo.listSignedOffFeedbackSyncJobs(100)).toEqual([]);
      await processFeedbackSyncJob(repo, job, writer);
      expect(write).toHaveBeenCalledTimes(2);
      expect((await pool.query("select count(*)::int as count from judge_runs where project_id='proj_test'")).rows[0].count).toBe(1);
      expect(await repo.listFeedbackSyncJobs({ projectId: "proj_test", limit: 10 })).toMatchObject([{ status: "synced", attempts: 1 }]);
      expect((await repo.getDashboardSummary("proj_test")).project.syncBackCoverage).toBe(1);
    } finally { await cleanup(); }
  }, 30_000);
});
