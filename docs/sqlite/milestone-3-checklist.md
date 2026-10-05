# Milestone 3 ordinary workflow parity checklist

CURRENT 2026-10-05. All 165 main repository methods are explicitly composed as
`RubristRepository`; TypeScript rejects missing methods. There is no proxy or
demo fallback. Links below map each method to native implementation and backend
tests. “Through worker/HTTP” means the test invokes the real higher-level path,
rather than calling the repository method directly. This is an implementation
and coverage index, not a substitute for the behavior assertions or the separate
Milestone 4 specialist/invariant inventory.

## Main repository

| Method | SQLite implementation | Backend tests |
| --- | --- | --- |
| `listProjects` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `getProjectSettings` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `updateProjectSettings` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `pruneExpiredTraces` | [project-commands.ts](../../apps/api/src/storage/sqlite/project-commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `deleteProject` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts), [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts) |
| `getDashboardSummary` | [project-commands.ts](../../apps/api/src/storage/sqlite/project-commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `getOnboardingEvidenceInventory` | [project-commands.ts](../../apps/api/src/storage/sqlite/project-commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `listCriteria` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts), [sqlite-definitions.test.ts](../../apps/api/test/sqlite-definitions.test.ts) |
| `getCriterion` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-definitions.test.ts](../../apps/api/test/sqlite-definitions.test.ts) |
| `createCriterion` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts), [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts) |
| `createCriterionVersion` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts), [sqlite-definitions.test.ts](../../apps/api/test/sqlite-definitions.test.ts) |
| `listEvaluatorSuites` | [suite-commands.ts](../../apps/api/src/storage/sqlite/suite-commands.ts) | [sqlite-suites.test.ts](../../apps/api/test/sqlite-suites.test.ts) |
| `getEvaluatorSuite` | [suite-commands.ts](../../apps/api/src/storage/sqlite/suite-commands.ts) | [sqlite-suites.test.ts](../../apps/api/test/sqlite-suites.test.ts) |
| `createEvaluatorSuiteManifest` | [suite-commands.ts](../../apps/api/src/storage/sqlite/suite-commands.ts) | [sqlite-suites.test.ts](../../apps/api/test/sqlite-suites.test.ts) |
| `listEvaluatorSuiteManifests` | [suite-commands.ts](../../apps/api/src/storage/sqlite/suite-commands.ts) | [sqlite-suites.test.ts](../../apps/api/test/sqlite-suites.test.ts) |
| `getEvaluatorSuiteManifest` | [suite-commands.ts](../../apps/api/src/storage/sqlite/suite-commands.ts) | [sqlite-suites.test.ts](../../apps/api/test/sqlite-suites.test.ts) |
| `getCurrentSkill` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-onboarding.test.ts](../../apps/api/test/sqlite-onboarding.test.ts), [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts) |
| `getCurrentSkillForCriterion` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-definitions.test.ts](../../apps/api/test/sqlite-definitions.test.ts) |
| `getLatestSkillForCriterion` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-definitions.test.ts](../../apps/api/test/sqlite-definitions.test.ts) |
| `getLatestSkill` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-definitions.test.ts](../../apps/api/test/sqlite-definitions.test.ts) |
| `getSkillVersion` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-onboarding.test.ts](../../apps/api/test/sqlite-onboarding.test.ts), [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts), [sqlite-definitions.test.ts](../../apps/api/test/sqlite-definitions.test.ts) |
| `authorizeSkillVersionExecution` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-definitions.test.ts](../../apps/api/test/sqlite-definitions.test.ts) |
| `getCriterionVersionForSkillVersion` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-definitions.test.ts](../../apps/api/test/sqlite-definitions.test.ts) |
| `signOffSkillVersion` | [skill-commands.ts](../../apps/api/src/storage/sqlite/skill-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts) |
| `createSkillVersion` | [regression-service.ts](../../apps/api/src/storage/sqlite/regression-service.ts) | [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts) |
| `createSkillVersionPending` | [runtime.ts](../../apps/api/src/storage/sqlite/runtime.ts), [skill-commands.ts](../../apps/api/src/storage/sqlite/skill-commands.ts) | [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts) |
| `runRegressionGateForVersion` | [regression-service.ts](../../apps/api/src/storage/sqlite/regression-service.ts) | [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts) |
| `failRegressionGateForVersion` | [regression-service.ts](../../apps/api/src/storage/sqlite/regression-service.ts) | [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts) |
| `listSkillVersions` | [definition-commands.ts](../../apps/api/src/storage/sqlite/definition-commands.ts) | [sqlite-onboarding.test.ts](../../apps/api/test/sqlite-onboarding.test.ts), [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts), [sqlite-definitions.test.ts](../../apps/api/test/sqlite-definitions.test.ts) |
| `listRegressionRunsForVersions` | [regression-commands.ts](../../apps/api/src/storage/sqlite/regression-commands.ts), [regression-service.ts](../../apps/api/src/storage/sqlite/regression-service.ts) | [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts) |
| `getRegressionRunForVersion` | [regression-commands.ts](../../apps/api/src/storage/sqlite/regression-commands.ts), [regression-service.ts](../../apps/api/src/storage/sqlite/regression-service.ts) | [sqlite-onboarding.test.ts](../../apps/api/test/sqlite-onboarding.test.ts), [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts) |
| `listGoldenSet` | [golden-commands.ts](../../apps/api/src/storage/sqlite/golden-commands.ts) | [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts) |
| `getSkillFormatExamples` | [golden-commands.ts](../../apps/api/src/storage/sqlite/golden-commands.ts) | [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts) |
| `getGoldenSetHealth` | [golden-commands.ts](../../apps/api/src/storage/sqlite/golden-commands.ts) | [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts) |
| `getExceptionDetail` | [golden-commands.ts](../../apps/api/src/storage/sqlite/golden-commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `getCaseDetail` | [golden-commands.ts](../../apps/api/src/storage/sqlite/golden-commands.ts) | [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts) |
| `promoteExceptionToGoldenSet` | [golden-commands.ts](../../apps/api/src/storage/sqlite/golden-commands.ts) | [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts), [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts) |
| `retireGoldenSetEntry` | [golden-commands.ts](../../apps/api/src/storage/sqlite/golden-commands.ts) | [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts) |
| `getGoldenSetTraces` | [golden-commands.ts](../../apps/api/src/storage/sqlite/golden-commands.ts) | [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts) |
| `importTrace` | [trace-commands.ts](../../apps/api/src/storage/sqlite/trace-commands.ts) | [sqlite-workflow.test.ts](../../apps/api/test/sqlite-workflow.test.ts), [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts) |
| `createImportJob` | [import-job-commands.ts](../../apps/api/src/storage/sqlite/import-job-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `markImportJobQueued` | [import-job-commands.ts](../../apps/api/src/storage/sqlite/import-job-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `markImportJobRunning` | [import-job-commands.ts](../../apps/api/src/storage/sqlite/import-job-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `markImportJobCompleted` | [import-job-commands.ts](../../apps/api/src/storage/sqlite/import-job-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `markImportJobFailed` | [import-job-commands.ts](../../apps/api/src/storage/sqlite/import-job-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) (through worker/HTTP) |
| `listImportJobs` | [import-job-commands.ts](../../apps/api/src/storage/sqlite/import-job-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `findImportedIronsideTraces` | [import-job-commands.ts](../../apps/api/src/storage/sqlite/import-job-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `getCaseSourceIdentity` | [trace-commands.ts](../../apps/api/src/storage/sqlite/trace-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-traces.test.ts](../../apps/api/test/sqlite-traces.test.ts) |
| `listLangSmithIntegrations` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `createLangSmithIntegration` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `updateLangSmithIntegration` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `recordLangSmithConnectionTest` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `deleteLangSmithIntegration` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `claimDueLangSmithImportTargets` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `loadLangSmithImportContext` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `listLangfuseIntegrations` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `createLangfuseIntegration` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `updateLangfuseIntegration` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `recordLangfuseConnectionTest` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `deleteLangfuseIntegration` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `claimDueLangfuseImportTargets` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `loadLangfuseImportContext` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `listIronsideIntegrations` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `createIronsideIntegration` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `updateIronsideIntegration` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `recordIronsideConnectionTest` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `quarantineIronsideIntegration` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `deleteIronsideIntegration` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `claimDueIronsideImportTargets` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `loadIronsideImportContext` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `saveIronsideSyncState` | [integration-commands.ts](../../apps/api/src/storage/sqlite/integration-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `loadJudgeRunContext` | [judge-commands.ts](../../apps/api/src/storage/sqlite/judge-commands.ts) | [sqlite-trace-tests.test.ts](../../apps/api/test/sqlite-trace-tests.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `recordJudgeRun` | [judge-commands.ts](../../apps/api/src/storage/sqlite/judge-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts), [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `createFeedbackSyncJob` | [feedback-commands.ts](../../apps/api/src/storage/sqlite/feedback-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `loadFeedbackSyncContext` | [feedback-commands.ts](../../apps/api/src/storage/sqlite/feedback-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `listFeedbackSyncJobs` | [feedback-commands.ts](../../apps/api/src/storage/sqlite/feedback-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `markFeedbackSyncSucceeded` | [feedback-commands.ts](../../apps/api/src/storage/sqlite/feedback-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `markFeedbackSyncFailed` | [feedback-commands.ts](../../apps/api/src/storage/sqlite/feedback-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `markFeedbackSyncBlocked` | [feedback-commands.ts](../../apps/api/src/storage/sqlite/feedback-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `markFeedbackSyncPending` | [feedback-commands.ts](../../apps/api/src/storage/sqlite/feedback-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `listBlockedIronsideFeedbackSyncJobs` | [feedback-commands.ts](../../apps/api/src/storage/sqlite/feedback-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `listSignedOffFeedbackSyncJobs` | [feedback-commands.ts](../../apps/api/src/storage/sqlite/feedback-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts) |
| `listCaseIdsForProject` | [trace-commands.ts](../../apps/api/src/storage/sqlite/trace-commands.ts) | [sqlite-traces.test.ts](../../apps/api/test/sqlite-traces.test.ts) |
| `listCases` | [trace-commands.ts](../../apps/api/src/storage/sqlite/trace-commands.ts) | [sqlite-onboarding.test.ts](../../apps/api/test/sqlite-onboarding.test.ts), [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-traces.test.ts](../../apps/api/test/sqlite-traces.test.ts) |
| `recordVerdict` | [judge-commands.ts](../../apps/api/src/storage/sqlite/judge-commands.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `listVerdicts` | [judge-commands.ts](../../apps/api/src/storage/sqlite/judge-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `caseExistsForProject` | [trace-commands.ts](../../apps/api/src/storage/sqlite/trace-commands.ts) | [sqlite-traces.test.ts](../../apps/api/test/sqlite-traces.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `getProjectKappaSummary` | [evidence-commands.ts](../../apps/api/src/storage/sqlite/evidence-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `getProjectJudgeHumanCalibration` | [evidence-commands.ts](../../apps/api/src/storage/sqlite/evidence-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `getDisagreementSummary` | [evidence-commands.ts](../../apps/api/src/storage/sqlite/evidence-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `getJudgeHumanDisagreementSummary` | [evidence-commands.ts](../../apps/api/src/storage/sqlite/evidence-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `getConvergenceAudit` | [convergence-commands.ts](../../apps/api/src/storage/sqlite/convergence-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `getSelfConsistencyReport` | [evidence-commands.ts](../../apps/api/src/storage/sqlite/evidence-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `listAuditEntries` | [evidence-commands.ts](../../apps/api/src/storage/sqlite/evidence-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts), [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `suggestReviewQueue` | [review-commands.ts](../../apps/api/src/storage/sqlite/review-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `createReviewQueue` | [review-commands.ts](../../apps/api/src/storage/sqlite/review-commands.ts) | [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts), [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `listReviewQueues` | [review-commands.ts](../../apps/api/src/storage/sqlite/review-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `getReviewQueueDetail` | [review-commands.ts](../../apps/api/src/storage/sqlite/review-commands.ts) | [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts), [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `getNextPendingQueueItem` | [review-commands.ts](../../apps/api/src/storage/sqlite/review-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `closeReviewQueue` | [review-commands.ts](../../apps/api/src/storage/sqlite/review-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `reopenReviewQueue` | [review-commands.ts](../../apps/api/src/storage/sqlite/review-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `addReviewQueueItems` | [review-commands.ts](../../apps/api/src/storage/sqlite/review-commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `createApiKey` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-onboarding.test.ts](../../apps/api/test/sqlite-onboarding.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts), [sqlite-production.test.ts](../../apps/api/test/sqlite-production.test.ts) |
| `listApiKeys` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `revokeApiKey` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-storage.test.ts](../../apps/api/test/sqlite-storage.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts), [sqlite-production.test.ts](../../apps/api/test/sqlite-production.test.ts) |
| `resolveApiKey` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `createTraceTest` | [trace-test-commands.ts](../../apps/api/src/storage/sqlite/trace-test-commands.ts) | [sqlite-trace-tests.test.ts](../../apps/api/test/sqlite-trace-tests.test.ts) |
| `listTraceTests` | [trace-test-commands.ts](../../apps/api/src/storage/sqlite/trace-test-commands.ts) | [sqlite-trace-tests.test.ts](../../apps/api/test/sqlite-trace-tests.test.ts) |
| `getTraceTest` | [trace-test-commands.ts](../../apps/api/src/storage/sqlite/trace-test-commands.ts) | [sqlite-trace-tests.test.ts](../../apps/api/test/sqlite-trace-tests.test.ts) |
| `reviseTraceTest` | [trace-test-commands.ts](../../apps/api/src/storage/sqlite/trace-test-commands.ts) | [sqlite-trace-tests.test.ts](../../apps/api/test/sqlite-trace-tests.test.ts) |
| `recordTraceTestValidation` | [trace-test-commands.ts](../../apps/api/src/storage/sqlite/trace-test-commands.ts) | [sqlite-trace-tests.test.ts](../../apps/api/test/sqlite-trace-tests.test.ts) |
| `enableTraceTest` | [trace-test-commands.ts](../../apps/api/src/storage/sqlite/trace-test-commands.ts) | [sqlite-trace-tests.test.ts](../../apps/api/test/sqlite-trace-tests.test.ts) |
| `recordTraceTestFunnelEvent` | [trace-test-commands.ts](../../apps/api/src/storage/sqlite/trace-test-commands.ts) | [sqlite-trace-tests.test.ts](../../apps/api/test/sqlite-trace-tests.test.ts) |
| `createDataset` | [dataset-commands.ts](../../apps/api/src/storage/sqlite/dataset-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-traces.test.ts](../../apps/api/test/sqlite-traces.test.ts) |
| `listDatasets` | [dataset-commands.ts](../../apps/api/src/storage/sqlite/dataset-commands.ts) | [sqlite-traces.test.ts](../../apps/api/test/sqlite-traces.test.ts) |
| `getDatasetDetail` | [dataset-commands.ts](../../apps/api/src/storage/sqlite/dataset-commands.ts) | [sqlite-traces.test.ts](../../apps/api/test/sqlite-traces.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `archiveDataset` | [dataset-commands.ts](../../apps/api/src/storage/sqlite/dataset-commands.ts) | [sqlite-traces.test.ts](../../apps/api/test/sqlite-traces.test.ts) |
| `addDatasetItems` | [dataset-commands.ts](../../apps/api/src/storage/sqlite/dataset-commands.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-traces.test.ts](../../apps/api/test/sqlite-traces.test.ts) |
| `importDatasetExamples` | [dataset-commands.ts](../../apps/api/src/storage/sqlite/dataset-commands.ts) | [sqlite-trace-tests.test.ts](../../apps/api/test/sqlite-trace-tests.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `createDatasetRevision` | [dataset-revision-commands.ts](../../apps/api/src/storage/sqlite/dataset-revision-commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `listDatasetRevisions` | [dataset-revision-commands.ts](../../apps/api/src/storage/sqlite/dataset-revision-commands.ts) | [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `getDatasetRevisionDetail` | [dataset-revision-commands.ts](../../apps/api/src/storage/sqlite/dataset-revision-commands.ts) | [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts), [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `recordDatasetRevisionContentView` | [dataset-revision-commands.ts](../../apps/api/src/storage/sqlite/dataset-revision-commands.ts) | [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `getOrCreateRegressionDatasetRevision` | [golden-commands.ts](../../apps/api/src/storage/sqlite/golden-commands.ts) | [sqlite-golden.test.ts](../../apps/api/test/sqlite-golden.test.ts) |
| `removeDatasetItem` | [dataset-commands.ts](../../apps/api/src/storage/sqlite/dataset-commands.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-traces.test.ts](../../apps/api/test/sqlite-traces.test.ts) |
| `setJudgeProviderKey` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `listJudgeProviderKeys` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts), [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts) |
| `deleteJudgeProviderKey` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `getJudgeProviderCredential` | [commands.ts](../../apps/api/src/storage/sqlite/commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts), [sqlite-skills.test.ts](../../apps/api/test/sqlite-skills.test.ts) |
| `createEvalRun` | [eval-commands.ts](../../apps/api/src/storage/sqlite/eval-commands.ts) | [sqlite-workflow.test.ts](../../apps/api/test/sqlite-workflow.test.ts), [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-trace-tests.test.ts](../../apps/api/test/sqlite-trace-tests.test.ts) |
| `createConvergenceEvalRun` | [eval-commands.ts](../../apps/api/src/storage/sqlite/eval-commands.ts) | [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `createImportedCaseEvalRun` | [eval-commands.ts](../../apps/api/src/storage/sqlite/eval-commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `claimEvalRunDispatch` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `rotateEvalRunDispatchJob` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `markEvalRunDispatched` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `releaseEvalRunDispatch` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `armEvalRunItemDeliveryDeadline` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `markEvalRunRunning` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `listPendingEvalRunItems` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `listPendingEvalRunItemDispatches` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `claimEvalRunItemExecution` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `rearmEvalRunItemDeliveryDeadline` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `claimEvalRunItemRecovery` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `beginEvalRunItemProviderCall` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `markEvalRunItemProviderCallReturned` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `releaseEvalRunItemExecution` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `listStaleEvalRunItemExecutions` | [eval-execution.ts](../../apps/api/src/storage/sqlite/eval-execution.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `getEvalRunItem` | [eval-commands.ts](../../apps/api/src/storage/sqlite/eval-commands.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `completeEvalRunItem` | [eval-commands.ts](../../apps/api/src/storage/sqlite/eval-commands.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts) |
| `failEvalRunItem` | [eval-commands.ts](../../apps/api/src/storage/sqlite/eval-commands.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `getEvalRun` | [eval-commands.ts](../../apps/api/src/storage/sqlite/eval-commands.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-trace-tests.test.ts](../../apps/api/test/sqlite-trace-tests.test.ts), [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `getEvalRunDetail` | [eval-commands.ts](../../apps/api/src/storage/sqlite/eval-commands.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-reviews.test.ts](../../apps/api/test/sqlite-reviews.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `listEvalRuns` | [eval-commands.ts](../../apps/api/src/storage/sqlite/eval-commands.ts) | [sqlite-integrations.test.ts](../../apps/api/test/sqlite-integrations.test.ts), [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `deleteUndispatchedEvalRun` | [eval-commands.ts](../../apps/api/src/storage/sqlite/eval-commands.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `getOrFreezeAssessmentReceipt` | [receipt-commands.ts](../../apps/api/src/storage/sqlite/receipt-commands.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts), [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `getAssessmentReceiptArtifactByReceiptId` | [receipt-commands.ts](../../apps/api/src/storage/sqlite/receipt-commands.ts) | [sqlite-dispatch.test.ts](../../apps/api/test/sqlite-dispatch.test.ts) |
| `listAssessmentReceiptArtifacts` | [receipt-commands.ts](../../apps/api/src/storage/sqlite/receipt-commands.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts) |
| `compareAssessmentReceiptCopy` | [receipt-commands.ts](../../apps/api/src/storage/sqlite/receipt-commands.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts) |
| `createAssessmentReceiptCorrection` | [receipt-commands.ts](../../apps/api/src/storage/sqlite/receipt-commands.ts) | [sqlite-evaluation.test.ts](../../apps/api/test/sqlite-evaluation.test.ts) |
| `createRunComparison` | [suite-commands.ts](../../apps/api/src/storage/sqlite/suite-commands.ts) | [sqlite-suites.test.ts](../../apps/api/test/sqlite-suites.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `getRunComparison` | [suite-commands.ts](../../apps/api/src/storage/sqlite/suite-commands.ts) | [sqlite-suites.test.ts](../../apps/api/test/sqlite-suites.test.ts), [sqlite-dataset-revisions.test.ts](../../apps/api/test/sqlite-dataset-revisions.test.ts) |
| `listRunComparisons` | [suite-commands.ts](../../apps/api/src/storage/sqlite/suite-commands.ts) | [sqlite-suites.test.ts](../../apps/api/test/sqlite-suites.test.ts) |
| `createGateCheck` | [historical-gate-commands.ts](../../apps/api/src/storage/sqlite/historical-gate-commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `getGateCheckDetail` | [historical-gate-commands.ts](../../apps/api/src/storage/sqlite/historical-gate-commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |
| `listGateChecks` | [historical-gate-commands.ts](../../apps/api/src/storage/sqlite/historical-gate-commands.ts) | [sqlite-projects.test.ts](../../apps/api/test/sqlite-projects.test.ts) |

## Additional storage and scheduled work

| Surface | Implementation | Backend evidence |
| --- | --- | --- |
| Production records: append/load, snapshot save/list/get, retention get/set/apply, decision erasure, revoked-key purge, snapshot deletion | `production-commands.ts`, migration 0025 | `sqlite-production.test.ts`: exact bytes, ordering, tenant scope, rollback, tombstones, orphan windows, counters and audits; authenticated ingestion in `sqlite-onboarding.test.ts` |
| Capability checks and provider resolution | `resolution-commands.ts` | `sqlite-resolution.test.ts`: expiry, credential scope, exact binding, failed-record durability |
| `eval.run`, `eval.item`, stale claim and outbox recovery | `workers/eval-run.ts`, `eval-execution.ts`, durable SQLite queue | `sqlite-workflow.test.ts`, `sqlite-evaluation.test.ts`, `sqlite-queue.test.ts`: provider dispatch crashes, restart, lease fencing, terminal receipt; `scheduled-shutdown.test.ts` drains recovery |
| `judge.run` | `workers/judge.ts` | `sqlite-integrations.test.ts`: durable delivery, persisted exact-version verdict |
| `gate.run`, durable backfill via `eval.run`/`eval.item` | `workers/gate.ts`, `regression-service.ts`, `regression-commands.ts` | `sqlite-onboarding.test.ts`, `sqlite-skills.test.ts`: authenticated editing, atomic outcome/exposure, overlapping attempts, SIGKILL recovery, failed gates do not backfill |
| `langsmith.import`, `langfuse.import`, `ironside.import` and each import poller | shared `workers/*-import.ts` and `workers/*-poller.ts`, native integration/import commands | `sqlite-integrations.test.ts`: claims, cursor CAS, quarantine, restart of queued imports for all three providers, controlled clients, exact version dispatch; `scheduled-shutdown.test.ts` drains active claims |
| `feedback.sync`, signed-off feedback recovery | `workers/feedback-sync.ts`, `feedback-commands.ts` | `sqlite-integrations.test.ts`: durable states, terminal fencing, blocked resume selection, controlled upstream delivery and coverage rollback; `scheduled-shutdown.test.ts` drains recovery |
| Production retention startup/periodic sweep | `production-calibration/retention.ts`, native `productionApplyRetention` | `sqlite-production.test.ts`; shared `production-retention.test.ts`/`production-retention-pg.test.ts` lifecycle/retention checks |
| Trace retention (request-triggered, not a timer) | `project-commands.ts` | `sqlite-projects.test.ts`: protected evidence, ordinary trace deletion, counters, audit rollback and throttling |
| Existing empty-project startup | `starter-evaluator.ts`, `worker.ts` before ready | `sqlite-onboarding.test.ts`: real-provider seed, existing account upgrade, idempotent restart and missing-credential 503 |

All ordinary worker and timer registrations are in `apps/api/src/index.ts`.
Binary calibration jobs and analysis-study deadline closure belong to Milestone 4.
External clients in backend tests are controlled fixtures; no paid provider or
real trace-service calls are needed.

CURRENT: M3 migrations now follow M2 terminal metadata guard 0009. Both evaluation-table rebuilds preserve immutable terminal start time and blocking metadata.
