import { serve } from "@hono/node-server";
import { runMigrations } from "@rubrist/db";
import { createQueue } from "@rubrist/queue";
import { createApp } from "./app.js";
import { createBinaryCalibrationProviderExecutor } from "./binary-calibration/provider.js";
import { PgBinaryCalibrationRepository } from "./binary-calibration/repository.pg.js";
import { registerBinaryCalibrationWorker } from "./binary-calibration/worker.js";
import { PgAnalysisStudyRepository, registerAnalysisStudyDeadlineCloser } from "./analysis-study/index.js";
import { PgAnalysisPromotionRepository } from "./analysis-promotion/index.js";
import { PgEvaluatorLifecycleRepository, savedVersionResolver } from "./evaluator-lifecycle/index.js";
import { PgAnalysisMeasurementRepository } from "./analysis-measurement/index.js";
import { createAuth } from "./lib/auth.js";
import { PgProductionDecisionRecordRepository } from "./production-calibration/repository.pg.js";
import { parseProductionRetentionIntervalMs, registerProductionRetentionSweeper } from "./production-calibration/retention.js";
import { createPgPool } from "./lib/db.js";
import { storageConfig } from "./storage/config.js";
import { createSqliteRuntime } from "./storage/sqlite/runtime.js";
import { createStrictJudgeProvider } from "./lib/judge-provider.js";
import { DemoRepository } from "./repository.js";
import { PgRepository } from "./repository.pg.js";
import { registerEvalRunWorkers } from "./workers/eval-run.js";
import { registerFeedbackSyncWorker } from "./workers/feedback-sync.js";
import { registerGateRunWorker } from "./workers/gate.js";
import { registerJudgeRunWorker } from "./workers/judge.js";
import { registerIronsideImportWorker } from "./workers/ironside-import.js";
import { parseIronsidePollImportLimit, parseIronsidePollIntervalMs, registerIronsidePoller } from "./workers/ironside-poller.js";
import { registerLangfuseImportWorker } from "./workers/langfuse-import.js";
import { parseLangfusePollImportLimit, parseLangfusePollIntervalMs, registerLangfusePoller } from "./workers/langfuse-poller.js";
import { registerLangSmithImportWorker } from "./workers/langsmith-import.js";
import { parsePollImportLimit, parsePollIntervalMs, registerLangSmithPoller } from "./workers/langsmith-poller.js";
import { stopScheduledTasks, type ScheduledTask } from "./workers/scheduled-tasks.js";
import { bindingResolutionServices, recheckGovernedBinding } from "./lib/binding-resolution.js";
import { PgCapabilityCheckStore } from "./lib/capability-check-store.js";

const port = Number(process.env.PORT ?? 8787);
const config = storageConfig();
const sqlite = config.kind === "sqlite" ? await createSqliteRuntime(config.path) : null;
const pool = config.kind === "postgres" ? createPgPool(config.url) : null;

if (pool) {
  await runMigrations(pool);
}

const auth = sqlite?.auth ?? (pool ? createAuth(pool) : undefined);
// Demo mode seeds verdicts so κ / disagreement feeds / calibration render
// without a worker or auth. Real mode (PgRepository) uses live data.
const repository = sqlite?.repository ?? (pool ? new PgRepository(pool) : new DemoRepository(undefined, { seedVerdicts: true }));
const pgBinaryCalibrationRepository = pool ? new PgBinaryCalibrationRepository(pool) : null;
const binaryCalibrationRepository = sqlite?.binaryCalibration ?? pgBinaryCalibrationRepository;
const binaryCalibrationExecutionRepository = sqlite?.binaryCalibrationExecution ?? pgBinaryCalibrationRepository;
const analysisStudyRepository = sqlite?.analysisStudies ?? (pool ? new PgAnalysisStudyRepository(pool) : null);
const analysisPromotionRepository = sqlite?.analysisPromotions ?? (pool ? new PgAnalysisPromotionRepository(pool) : null);
const evaluatorLifecycleRepository = sqlite?.evaluatorLifecycle ?? (pool ? new PgEvaluatorLifecycleRepository(pool) : null);
const analysisMeasurementRepository = sqlite?.analysisMeasurement ?? (pool ? new PgAnalysisMeasurementRepository(pool) : null);
const productionDecisionRecordRepository=sqlite?.productionRecords ?? (pool?new PgProductionDecisionRecordRepository(pool):null);
const resolutionRepository=sqlite?.resolution ?? evaluatorLifecycleRepository;
const queue = sqlite?.queue ?? (pool ? createQueue() : undefined);
const pollers: ScheduledTask[] = [];

if (analysisStudyRepository) {
  pollers.push(await registerAnalysisStudyDeadlineCloser(analysisStudyRepository));
}

if (productionDecisionRecordRepository) {
  pollers.push(registerProductionRetentionSweeper(productionDecisionRecordRepository, {
    intervalMs: parseProductionRetentionIntervalMs(process.env.PRODUCTION_RETENTION_INTERVAL_MS)
  }));
}

if (queue) {
  await queue.start();
  // BOTH judge workers are strict about credentials: a non-mock binding with
  // no key FAILS the item instead of silently recording mock verdicts. With
  // openrouter/custom bindings there is no environment-key fallback at all, so
  // a deleted project key would otherwise degrade EVERY subsequent judge run
  // to the mock heuristic while still recording source=llm_judge.
  pollers.push(await registerEvalRunWorkers(queue, repository, createStrictJudgeProvider));
  await registerJudgeRunWorker(queue, repository, createStrictJudgeProvider);
  // The gate worker needs no strict factory: runRegressionGateForVersion has
  // its own mock-degradation refusal (the original gate guard).
  await registerGateRunWorker(queue, repository, resolutionRepository ? {
    // Resolution after save (ADR-0014 section 4): the gate worker confirms a
    // saved binding before its regression gate.
    resolveSaved: savedVersionResolver(
      resolutionRepository,
      bindingResolutionServices((projectId, provider) => repository.getJudgeProviderCredential(projectId, provider), {
        ...(sqlite ? {checks:sqlite.capabilityChecks} : pool ? { checks: new PgCapabilityCheckStore(pool) } : {})
      })
    )
  } : {});
  await registerLangSmithImportWorker(queue, repository);
  await registerLangfuseImportWorker(queue, repository);
  await registerIronsideImportWorker(queue, repository);
  pollers.push(await registerFeedbackSyncWorker(queue, repository));
  if (binaryCalibrationExecutionRepository) {
    const binaryCalibrationOrchestrator = await registerBinaryCalibrationWorker(
      queue,
      binaryCalibrationExecutionRepository,
      createBinaryCalibrationProviderExecutor({
        resolveProjectCredential: (projectId, provider) =>
          repository.getJudgeProviderCredential(projectId, provider)
      }),
      {
        recheck: (binding) => recheckGovernedBinding(
          bindingResolutionServices((projectId, provider) => repository.getJudgeProviderCredential(projectId, provider)),
          binding
        )
      }
    );
    pollers.push(binaryCalibrationOrchestrator);
  }
  pollers.push(registerLangSmithPoller(queue, repository, {
    intervalMs: parsePollIntervalMs(process.env.LANGSMITH_POLL_INTERVAL_MS),
    importLimit: parsePollImportLimit(process.env.LANGSMITH_POLL_IMPORT_LIMIT)
  }));
  pollers.push(registerLangfusePoller(queue, repository, {
    intervalMs: parseLangfusePollIntervalMs(process.env.LANGFUSE_POLL_INTERVAL_MS),
    importLimit: parseLangfusePollImportLimit(process.env.LANGFUSE_POLL_IMPORT_LIMIT)
  }));
  pollers.push(registerIronsidePoller(queue, repository, {
    intervalMs: parseIronsidePollIntervalMs(process.env.IRONSIDE_POLL_INTERVAL_MS),
    importLimit: parseIronsidePollImportLimit(process.env.IRONSIDE_POLL_IMPORT_LIMIT)
  }));
}

const server = serve({
  fetch: createApp(repository, {
    auth,
    runtimeMode: config.kind === "demo" ? "demo" : "persistent",
    ...(sqlite ? {accounts:sqlite.accounts,capabilityChecks:sqlite.capabilityChecks} : {}),
    pool: pool ?? undefined,
    queue,
    governedReviewRepository:sqlite?.governedReview,
    analysisPopulationRepository:sqlite?.analysisPopulations,
    analysisStudyRepository,
    analysisPromotionRepository,
    binaryCalibrationRepository,
    evaluatorLifecycleRepository,
    analysisMeasurementRepository,
    productionDecisionRecordRepository
  }).fetch,
  port
});

console.log(`Rubrist API listening on http://localhost:${port}${sqlite ? " (SQLite)" : pool ? " (Postgres + judge worker)" : " (demo)"}`);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`Received ${signal}; shutting down Rubrist API`);
  const forceExit = setTimeout(() => {
    console.error("Timed out while shutting down Rubrist API; forcing exit");
    process.exit(1);
  }, 30_000);
  forceExit.unref();

  try {
    const failedTasks = await stopScheduledTasks(pollers);
    await closeServer();
    await queue?.stop();
    await pool?.end();
    await sqlite?.close();
    clearTimeout(forceExit);
    process.exit(failedTasks === 0 ? 0 : 1);
  } catch (error) {
    clearTimeout(forceExit);
    console.error("Failed to shut down Rubrist API cleanly", error);
    process.exit(1);
  }
}

async function closeServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

process.once("SIGINT", (signal) => void shutdown(signal));
process.once("SIGTERM", (signal) => void shutdown(signal));
