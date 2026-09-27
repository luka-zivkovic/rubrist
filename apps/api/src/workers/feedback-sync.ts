import { z } from "zod";
import { FeedbackSyncJobSchema, type FeedbackSyncJob } from "@rubrist/shared";
import type { Queue } from "@rubrist/queue";
import type { RubristRepository, FeedbackSyncContext } from "../repository.js";
import {
  FeedbackSyncCredentialsMissingError,
  FeedbackSyncJobNotFoundError,
  IronsideIntegrationRevalidationRequiredError
} from "../repository.js";
import { LangSmithClient, type LangSmithFeedbackWriter } from "../lib/langsmith.js";
import { LangfuseClient } from "../lib/langfuse.js";
import { PROVISIONAL_FEEDBACK_HOLD } from "../lib/provisional-feedback.js";
import { IronsideClient } from "../lib/ironside.js";

export type FeedbackWriterFactory = (context: FeedbackSyncContext) => LangSmithFeedbackWriter;
export type LangSmithFeedbackWriterFactory = FeedbackWriterFactory;

export async function registerFeedbackSyncWorker(
  queue: Queue,
  repository: RubristRepository,
  createWriter: FeedbackWriterFactory = defaultFeedbackWriterFactory
): Promise<void> {
  await queue.work<FeedbackSyncJob>("feedback.sync", async ({ id, data }) => {
    try {
      await processFeedbackSyncJob(repository, data, createWriter);
    } catch (error) {
      if (error instanceof IronsideIntegrationRevalidationRequiredError) {
        console.warn(`feedback.sync job ${id} parked until Ironside revalidation`);
        return;
      }
      if (isPermanentFeedbackSyncError(error)) {
        console.error(`feedback.sync job ${id} permanently failed; dropping:`, error);
        return;
      }
      throw error;
    }
  });
  // The durable blocked row is the outbox: leave it blocked until the worker
  // delivers it. A crash or failed queue send cannot lose the sign-off resume.
  let resuming = false;
  const resume = async () => {
    if (resuming) return;
    resuming = true;
    try { await resumeSignedOffFeedback(repository, queue); }
    catch (error) { console.error("feedback.sync sign-off recovery failed:", error); }
    finally { resuming = false; }
  };
  await resume();
  const timer = setInterval(() => { void resume(); }, 30_000);
  timer.unref();
}

export async function resumeSignedOffFeedback(repository: RubristRepository, queue: Queue): Promise<number> {
  const jobs = await repository.listSignedOffFeedbackSyncJobs(100);
  let queued = 0;
  for (const job of jobs) {
    try {
      const id = await queue.send("feedback.sync", job, {
        retryLimit: 5, retryBackoff: true,
        singletonKey: `signoff:${job.feedbackSyncJobId}`, singletonSeconds: 30
      });
      if (id) queued++;
    } catch (error) {
      // Keep this and every other held row recoverable on the next tick.
      console.error("feedback.sync sign-off dispatch failed:", error);
    }
  }
  return queued;
}

export async function processFeedbackSyncJob(
  repository: RubristRepository,
  job: FeedbackSyncJob,
  createWriter: FeedbackWriterFactory = defaultFeedbackWriterFactory
): Promise<void> {
  const parsed = FeedbackSyncJobSchema.parse(job);
  const context = await repository.loadFeedbackSyncContext(parsed);
  if (context.status === "synced") return;
  try {
    const version = await repository.getSkillVersion(context.projectId, context.judgeRun.skillVersionId);
    if (!version) throw new Error("Evaluator version unavailable for feedback delivery");
    if (version.status === "draft" && version.approvedAt === null) {
      await repository.markFeedbackSyncBlocked(parsed, new Error(PROVISIONAL_FEEDBACK_HOLD));
      return;
    }
    if (
      context.provider === "ironside" &&
      "revalidationRequired" in context.integration &&
      context.integration.revalidationRequired
    ) {
      throw new IronsideIntegrationRevalidationRequiredError(context.integration.id);
    }
    const writer = createWriter(context);
    if (
      context.provider === "ironside" &&
      "getContext" in writer &&
      typeof writer.getContext === "function"
    ) {
      const remote = await writer.getContext();
      const integration = context.integration;
      if (!("remoteProjectId" in integration)) {
        throw new FeedbackSyncCredentialsMissingError(context.id);
      }
      if (remote.project.id !== integration.remoteProjectId) {
        const checkedAt = new Date().toISOString();
        const quarantined = await repository.quarantineIronsideIntegration(
          context.projectId,
          integration.id,
          {
            remoteProjectId: integration.remoteProjectId,
            connectionRevision: integration.connectionRevision
          },
          {
            ok: false,
            checkedAt,
            error: `Configured credentials resolve to Ironside project ${remote.project.id}, expected ${integration.remoteProjectId}`
          }
        );
        if (!quarantined) throw new Error("Ironside integration changed during identity check");
        throw new IronsideIntegrationRevalidationRequiredError(integration.id);
      }
    }
    await writer.createFeedback({
      // Every writer accepts a caller-provided score/feedback id. Reusing the
      // durable feedback_sync_jobs id makes retries idempotent.
      feedbackId: context.id,
      runId: context.sourceTraceId,
      key: context.provider === "ironside"
        ? `rubrist_assessment/${context.criterionStableKey}`
        : "rubrist_verdict",
      score: context.judgeRun.score,
      value: context.judgeRun.verdict,
      comment: context.judgeRun.reasoning,
      sourceInfo: {
        skillVersionId: context.judgeRun.skillVersionId,
        criterionKey: context.criterionStableKey,
        sourceTraceVersion: context.sourceTraceVersion,
        executionBinding: context.judgeRun.executionBinding,
        judgeRunId: context.judgeRun.id,
        provider: "rubrist"
      }
    });
    await repository.markFeedbackSyncSucceeded(parsed);
  } catch (error) {
    if (error instanceof IronsideIntegrationRevalidationRequiredError) {
      // Quarantine is an operator-recoverable pause, not a terminal delivery
      // failure. Park the durable job so a successful connection test can
      // enqueue it again without spending through a finite queue retry budget.
      await repository.markFeedbackSyncBlocked(parsed, error);
    } else {
      await repository.markFeedbackSyncFailed(parsed, error);
    }
    throw error;
  }
}

export function defaultFeedbackWriterFactory(context: FeedbackSyncContext): LangSmithFeedbackWriter {
  if (context.provider === "langfuse") {
    const integration = context.integration;
    if (!("publicKey" in integration)) throw new FeedbackSyncCredentialsMissingError(context.id);
    return new LangfuseClient({
      publicKey: integration.publicKey,
      secretKey: integration.secretKey,
      endpointUrl: integration.endpointUrl
    });
  }
  if (context.provider === "ironside") {
    const integration = context.integration;
    if (!("url" in integration) || !("apiKey" in integration)) throw new FeedbackSyncCredentialsMissingError(context.id);
    return new IronsideClient({ url: integration.url, apiKey: integration.apiKey });
  }
  const integration = context.integration;
  if (!("apiKey" in integration) || "url" in integration) throw new FeedbackSyncCredentialsMissingError(context.id);
  return new LangSmithClient({ apiKey: integration.apiKey, endpointUrl: integration.endpointUrl });
}

export const defaultLangSmithFeedbackWriterFactory = defaultFeedbackWriterFactory;

export function isPermanentFeedbackSyncError(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  if (error instanceof FeedbackSyncJobNotFoundError) return true;
  if (error instanceof FeedbackSyncCredentialsMissingError) return true;
  if (error instanceof IronsideIntegrationRevalidationRequiredError) return true;
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403 || status === 404) return true;
  }
  return false;
}
