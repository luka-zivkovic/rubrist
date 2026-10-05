import type { AnalysisStudyRepository } from '../../analysis-study/repository.js';
import type { AnalysisPopulationRepository } from '../../analysis-population/repository.js';
import type { ProductionDecisionRecordRepository } from '../../production-calibration/repository.js';
import { sqliteRegressionService } from './regression-service.js';
import { createStrictJudgeProvider, JudgeProviderUnavailableError, type JudgeProviderFactory } from '../../lib/judge-provider.js';
import { executionBindingFromInput } from '../../lib/execution-binding.js';
import { RegressionGateUnavailableError } from '../../repository/errors.js';
import type { CapabilityCheckStore } from '../../lib/capability-check-store.js';
import type { EvaluatorLifecycleRepository } from '../../evaluator-lifecycle/repository.js';
import { SqliteQueue } from '@rubrist/queue/sqlite';
import type { AccountServices } from '../../accounts/ports.js';
import type { RubristRepository } from '../../repository.js';
import { SqliteStorage } from './client.js';

export { SqliteFeatureUnavailableError } from './feature-error.js';
export async function createSqliteRuntime(path: string, judgeProviderFactory:JudgeProviderFactory=createStrictJudgeProvider, options:{seedStarterEvaluators?:boolean}={}) {
  const storage = new SqliteStorage(path,options);
  try { await storage.ready; } catch(error) { await storage.close(); throw error; }
  const analysisStudies:AnalysisStudyRepository={
    createStudy:(...args)=>storage.command('studyCreate',...args),
    listStudies:(...args)=>storage.command('studyList',...args),
    getStudy:(...args)=>storage.command('studyGet',...args),
    openStudy:(...args)=>storage.command('studyOpen',...args),
    closeStudy:(...args)=>storage.command('studyClose',...args),
    completeStudy:(...args)=>storage.command('studyComplete',...args),
    abandonStudy:(...args)=>storage.command('studyAbandon',...args),
    listStudyItems:(...args)=>storage.command('studyItems',...args),
    listStudyItemEvents:(...args)=>storage.command('studyItemEvents',...args),
    getStudyItem:(...args)=>storage.command('studyItemGet',...args),
    appendStudyItemEvent:(...args)=>storage.command('studyItemAppend',...args),
    getStudyItemContent:(...args)=>storage.command('studyItemContent',...args),
    createTaxonomy:(...args)=>storage.command('studyTaxonomyCreate',...args),
    getTaxonomy:(...args)=>storage.command('studyTaxonomyGet',...args),
    listTaxonomyRevisions:(...args)=>storage.command('studyTaxonomyRevisions',...args),
    getTaxonomyRevision:(...args)=>storage.command('studyTaxonomyRevisionGet',...args),
    createTaxonomyRevision:(...args)=>storage.command('studyTaxonomyRevise',...args),
    listObservationAssignments:(...args)=>storage.command('studyAssignments',...args),
    appendObservationAssignment:(...args)=>storage.command('studyAssignmentAppend',...args),
    getTaxonomyCoverage:(...args)=>storage.command('studyCoverage',...args),
    closeDueStudies:(...args)=>storage.command('studyCloseDue',...args),
  };
  const analysisPopulations:AnalysisPopulationRepository={
    createPopulation:(...args)=>storage.command('populationCreate',...args),
    listPopulations:(...args)=>storage.command('populationList',...args),
    getPopulation:(...args)=>storage.command('populationGet',...args),
    listMembers:(...args)=>storage.command('populationMembers',...args),
    listSelections:(...args)=>storage.command('populationSelections',...args),
    listExclusions:(...args)=>storage.command('populationExclusions',...args),
    listOverlaps:(...args)=>storage.command('populationOverlaps',...args),
    getSelectedContent:(...args)=>storage.command('populationSelectedContent',...args)
  };
  const productionRecords:ProductionDecisionRecordRepository={
    appendRecords:(...args)=>storage.command('productionAppendRecords',...args),
    loadRecords:(...args)=>storage.command('productionLoadRecords',...args),
    saveSnapshot:(...args)=>storage.command('productionSaveSnapshot',...args),
    listSnapshots:(...args)=>storage.command('productionListSnapshots',...args),
    getSnapshot:(...args)=>storage.command('productionGetSnapshot',...args),
    getRetentionDays:(...args)=>storage.command('productionGetRetentionDays',...args),
    setRetentionDays:(...args)=>storage.command('productionSetRetentionDays',...args),
    applyRetention:(...args)=>storage.command('productionApplyRetention',...args),
    eraseDecision:(...args)=>storage.command('productionEraseDecision',...args),
    purgeApiKeyRecords:(...args)=>storage.command('productionPurgeApiKeyRecords',...args),
    deleteSnapshot:(...args)=>storage.command('productionDeleteSnapshot',...args),
  };
  const capabilityChecks:CapabilityCheckStore={
    put:(entry)=>storage.command('capabilityCheckPut',entry),
    get:(...args)=>storage.command('capabilityCheckGet',...args)
  };
  const resolution:Pick<EvaluatorLifecycleRepository,'getGovernedBinding'|'recordResolution'>={
    getGovernedBinding:(...args)=>storage.command('getGovernedBinding',...args),
    recordResolution:(...args)=>storage.command('recordResolution',...args)
  };
  const queue = new SqliteQueue({
    send: (...args) => storage.command('queueSend', ...args),
    state: (...args) => storage.command('queueState', ...args),
    recover: (...args) => storage.command('queueRecover', ...args),
    claim: (...args) => storage.command('queueClaim', ...args),
    settle: (...args) => storage.command('queueSettle', ...args)
  });
  let setup = Promise.resolve();
  const accounts: AccountServices = {
    countUsers: () => storage.command('countUsers'),
    setupRequired: () => storage.command('setupRequired'),
    bootstrapOwnerUserByEmail: (...args) => storage.command('bootstrapOwnerUserByEmail',...args),
    ensureWorkspaceForUser: (...args) => storage.command('ensureWorkspaceForUser',...args),
    createProjectForUser: (...args) => storage.command('createProjectForUser',...args),
    firstProjectForUser: (...args) => storage.command('firstProjectForUser',...args),
    userProjectRole: (...args) => storage.command('userProjectRole',...args),
    createInvitation: (...args) => storage.command('createInvitation',...args),
    validateInvitation: (...args) => storage.command('validateInvitation',...args),
    redeemInvitation: (...args) => storage.command('redeemInvitation',...args),
    pairingEligibility: (...args) => storage.command('pairingEligibility',...args),
    createAgentSetupPairing: (...args) => storage.command('createAgentSetupPairing',...args),
    getAgentSetupPairing: (...args) => storage.command('getAgentSetupPairing',...args),
    resolveAgentSetupPairing: (...args) => storage.command('resolveAgentSetupPairing',...args),
    claimAgentSetupPairing: (...args) => storage.command('claimAgentSetupPairing',...args),
    releaseAgentSetupPairing: (...args) => storage.command('releaseAgentSetupPairing',...args),
    completeAgentSetupPairing: (...args) => storage.command('completeAgentSetupPairing',...args),
    invalidateAgentSetupPairing: (...args) => storage.command('invalidateAgentSetupPairing',...args),
    revokeAgentSetupPairing: (...args) => storage.command('revokeAgentSetupPairing',...args),
    recordCaseView: (...args) => storage.command('recordCaseView',...args),
    withSetupLock(work) {
      const result = setup.then(work);
      setup = result.then(() => undefined,() => undefined);
      return result;
    }
  };
  const methods = {
    signOffSkillVersion: (...args) => storage.command('signOffSkillVersion',...args),
    async createSkillVersionPending(skillId,input,context) {
      const stored=executionBindingFromInput(input.executionBinding,undefined,{typedQuestion:input.typedQuestion!==undefined});
      const provider=stored.executionBinding.provider,supplied=context.agentSetup?.providerCredential;
      const key=supplied?.provider===provider?supplied.apiKey:provider!=='mock'?await storage.command('getJudgeProviderCredential',context.projectId,provider):null;
      const judge=(()=>{try{return judgeProviderFactory({...stored,rubricMarkdown:input.rubricMarkdown??null,prompt:input.prompt??null,typedQuestion:input.typedQuestion??null,decisionThreshold:input.decisionThreshold??null},key?{apiKey:key}:undefined);}catch(error){if(error instanceof JudgeProviderUnavailableError)throw new RegressionGateUnavailableError(provider);throw error;}})();
      if(provider!=='mock'&&judge.name==='mock')throw new RegressionGateUnavailableError(provider);
      return storage.command('insertPendingSkillVersion',skillId,input,context);
    },
    createGateCheck: (...args) => storage.command('createGateCheck',...args),
    getGateCheckDetail: (...args) => storage.command('getGateCheckDetail',...args),
    listGateChecks: (...args) => storage.command('listGateChecks',...args),
    getDashboardSummary: (...args) => storage.command('getDashboardSummary',...args),
    getOnboardingEvidenceInventory: (...args) => storage.command('getOnboardingEvidenceInventory',...args),
    pruneExpiredTraces: (...args) => storage.command('pruneExpiredTraces',...args),
    loadFeedbackSyncContext: (...args) => storage.command('loadFeedbackSyncContext',...args),
    listFeedbackSyncJobs: (...args) => storage.command('listFeedbackSyncJobs',...args),
    markFeedbackSyncSucceeded: (...args) => storage.command('markFeedbackSyncSucceeded',...args),
    markFeedbackSyncFailed: (...args) => storage.command('markFeedbackSyncFailed',...args),
    markFeedbackSyncBlocked: (...args) => storage.command('markFeedbackSyncBlocked',...args),
    markFeedbackSyncPending: (...args) => storage.command('markFeedbackSyncPending',...args),
    listBlockedIronsideFeedbackSyncJobs: (...args) => storage.command('listBlockedIronsideFeedbackSyncJobs',...args),
    listSignedOffFeedbackSyncJobs: (...args) => storage.command('listSignedOffFeedbackSyncJobs',...args),
    createImportJob: (...args) => storage.command('createImportJob',...args),
    markImportJobQueued: (...args) => storage.command('markImportJobQueued',...args),
    markImportJobRunning: (...args) => storage.command('markImportJobRunning',...args),
    markImportJobCompleted: (...args) => storage.command('markImportJobCompleted',...args),
    markImportJobFailed: (...args) => storage.command('markImportJobFailed',...args),
    listImportJobs: (...args) => storage.command('listImportJobs',...args),
    findImportedIronsideTraces: (...args) => storage.command('findImportedIronsideTraces',...args),
    createLangSmithIntegration: (...args) => storage.command('createLangSmithIntegration',...args),
    listLangSmithIntegrations: (...args) => storage.command('listLangSmithIntegrations',...args),
    updateLangSmithIntegration: (...args) => storage.command('updateLangSmithIntegration',...args),
    recordLangSmithConnectionTest: (...args) => storage.command('recordLangSmithConnectionTest',...args),
    deleteLangSmithIntegration: (...args) => storage.command('deleteLangSmithIntegration',...args),
    claimDueLangSmithImportTargets: (...args) => storage.command('claimDueLangSmithImportTargets',...args),
    loadLangSmithImportContext: (...args) => storage.command('loadLangSmithImportContext',...args),
    createLangfuseIntegration: (...args) => storage.command('createLangfuseIntegration',...args),
    listLangfuseIntegrations: (...args) => storage.command('listLangfuseIntegrations',...args),
    updateLangfuseIntegration: (...args) => storage.command('updateLangfuseIntegration',...args),
    recordLangfuseConnectionTest: (...args) => storage.command('recordLangfuseConnectionTest',...args),
    deleteLangfuseIntegration: (...args) => storage.command('deleteLangfuseIntegration',...args),
    claimDueLangfuseImportTargets: (...args) => storage.command('claimDueLangfuseImportTargets',...args),
    loadLangfuseImportContext: (...args) => storage.command('loadLangfuseImportContext',...args),
    createIronsideIntegration: (...args) => storage.command('createIronsideIntegration',...args),
    listIronsideIntegrations: (...args) => storage.command('listIronsideIntegrations',...args),
    updateIronsideIntegration: (...args) => storage.command('updateIronsideIntegration',...args),
    recordIronsideConnectionTest: (...args) => storage.command('recordIronsideConnectionTest',...args),
    deleteIronsideIntegration: (...args) => storage.command('deleteIronsideIntegration',...args),
    claimDueIronsideImportTargets: (...args) => storage.command('claimDueIronsideImportTargets',...args),
    loadIronsideImportContext: (...args) => storage.command('loadIronsideImportContext',...args),
    quarantineIronsideIntegration: (...args) => storage.command('quarantineIronsideIntegration',...args),
    saveIronsideSyncState: (...args) => storage.command('saveIronsideSyncState',...args),
    createTraceTest: (...args) => storage.command('createTraceTest',...args),
    listTraceTests: (...args) => storage.command('listTraceTests',...args),
    getTraceTest: (...args) => storage.command('getTraceTest',...args),
    reviseTraceTest: (...args) => storage.command('reviseTraceTest',...args),
    recordTraceTestValidation: (...args) => storage.command('recordTraceTestValidation',...args),
    enableTraceTest: (...args) => storage.command('enableTraceTest',...args),
    recordTraceTestFunnelEvent: (...args) => storage.command('recordTraceTestFunnelEvent',...args),
    createConvergenceEvalRun: (...args) => storage.command('createConvergenceEvalRun',...args),
    createImportedCaseEvalRun: (...args) => storage.command('createImportedCaseEvalRun',...args),
    listGoldenSet: (...args) => storage.command('listGoldenSet',...args),
    getSkillFormatExamples: (...args) => storage.command('getSkillFormatExamples',...args),
    getGoldenSetHealth: (...args) => storage.command('getGoldenSetHealth',...args),
    getGoldenSetTraces: (...args) => storage.command('getGoldenSetTraces',...args),
    getExceptionDetail: (...args) => storage.command('getExceptionDetail',...args),
    getCaseDetail: (...args) => storage.command('getCaseDetail',...args),
    getOrCreateRegressionDatasetRevision: (...args) => storage.command('getOrCreateRegressionDatasetRevision',...args),
    promoteExceptionToGoldenSet: (...args) => storage.command('promoteExceptionToGoldenSet',...args),
    retireGoldenSetEntry: (...args) => storage.command('retireGoldenSetEntry',...args),

    getConvergenceAudit: (...args) => storage.command('getConvergenceAudit',...args),
    getProjectKappaSummary: (...args) => storage.command('getProjectKappaSummary',...args),
    getProjectJudgeHumanCalibration: (...args) => storage.command('getProjectJudgeHumanCalibration',...args),
    getDisagreementSummary: (...args) => storage.command('getDisagreementSummary',...args),
    getJudgeHumanDisagreementSummary: (...args) => storage.command('getJudgeHumanDisagreementSummary',...args),
    getSelfConsistencyReport: (...args) => storage.command('getSelfConsistencyReport',...args),
    listAuditEntries: (...args) => storage.command('listAuditEntries',...args),

    suggestReviewQueue: (...args) => storage.command('suggestReviewQueue',...args),
    createReviewQueue: (...args) => storage.command('createReviewQueue',...args),
    listReviewQueues: (...args) => storage.command('listReviewQueues',...args),
    getReviewQueueDetail: (...args) => storage.command('getReviewQueueDetail',...args),
    getNextPendingQueueItem: (...args) => storage.command('getNextPendingQueueItem',...args),
    closeReviewQueue: (...args) => storage.command('closeReviewQueue',...args),
    reopenReviewQueue: (...args) => storage.command('reopenReviewQueue',...args),
    addReviewQueueItems: (...args) => storage.command('addReviewQueueItems',...args),

    listEvaluatorSuites: (...args) => storage.command('listEvaluatorSuites',...args),
    getEvaluatorSuite: (...args) => storage.command('getEvaluatorSuite',...args),
    createEvaluatorSuiteManifest: (...args) => storage.command('createEvaluatorSuiteManifest',...args),
    listEvaluatorSuiteManifests: (...args) => storage.command('listEvaluatorSuiteManifests',...args),
    getEvaluatorSuiteManifest: (...args) => storage.command('getEvaluatorSuiteManifest',...args),
    createRunComparison: (...args) => storage.command('createRunComparison',...args),
    getRunComparison: (...args) => storage.command('getRunComparison',...args),
    listRunComparisons: (...args) => storage.command('listRunComparisons',...args),

    createDatasetRevision: (...args) => storage.command('createDatasetRevision',...args),
    listDatasetRevisions: (...args) => storage.command('listDatasetRevisions',...args),
    getDatasetRevisionDetail: (...args) => storage.command('getDatasetRevisionDetail',...args),
    recordDatasetRevisionContentView: (...args) => storage.command('recordDatasetRevisionContentView',...args),

    importDatasetExamples: (...args) => storage.command('importDatasetExamples',...args),
    createEvalRun: (...args) => storage.command('createEvalRun',...args),
    getEvalRun: (...args) => storage.command('getEvalRun',...args),
    getEvalRunItem: (...args) => storage.command('getEvalRunItem',...args),
    getEvalRunDetail: (...args) => storage.command('getEvalRunDetail',...args),
    listEvalRuns: (...args) => storage.command('listEvalRuns',...args),
    completeEvalRunItem: (...args) => storage.command('completeEvalRunItem',...args),
    failEvalRunItem: (...args) => storage.command('failEvalRunItem',...args),
    deleteUndispatchedEvalRun: (...args) => storage.command('deleteUndispatchedEvalRun',...args),
    claimEvalRunDispatch: (...args) => storage.command('claimEvalRunDispatch',...args),
    rotateEvalRunDispatchJob: (...args) => storage.command('rotateEvalRunDispatchJob',...args),
    markEvalRunDispatched: (...args) => storage.command('markEvalRunDispatched',...args),
    releaseEvalRunDispatch: (...args) => storage.command('releaseEvalRunDispatch',...args),
    armEvalRunItemDeliveryDeadline: (...args) => storage.command('armEvalRunItemDeliveryDeadline',...args),
    markEvalRunRunning: (...args) => storage.command('markEvalRunRunning',...args),
    listPendingEvalRunItems: (...args) => storage.command('listPendingEvalRunItems',...args),
    listPendingEvalRunItemDispatches: (...args) => storage.command('listPendingEvalRunItemDispatches',...args),
    claimEvalRunItemExecution: (...args) => storage.command('claimEvalRunItemExecution',...args),
    rearmEvalRunItemDeliveryDeadline: (...args) => storage.command('rearmEvalRunItemDeliveryDeadline',...args),
    claimEvalRunItemRecovery: (...args) => storage.command('claimEvalRunItemRecovery',...args),
    beginEvalRunItemProviderCall: (...args) => storage.command('beginEvalRunItemProviderCall',...args),
    markEvalRunItemProviderCallReturned: (...args) => storage.command('markEvalRunItemProviderCallReturned',...args),
    releaseEvalRunItemExecution: (...args) => storage.command('releaseEvalRunItemExecution',...args),
    listStaleEvalRunItemExecutions: (...args) => storage.command('listStaleEvalRunItemExecutions',...args),
    getOrFreezeAssessmentReceipt: (...args) => storage.command('getOrFreezeAssessmentReceipt',...args),
    getAssessmentReceiptArtifactByReceiptId: (...args) => storage.command('getAssessmentReceiptArtifactByReceiptId',...args),
    listAssessmentReceiptArtifacts: (...args) => storage.command('listAssessmentReceiptArtifacts',...args),
    compareAssessmentReceiptCopy: (...args) => storage.command('compareAssessmentReceiptCopy',...args),
    createAssessmentReceiptCorrection: (...args) => storage.command('createAssessmentReceiptCorrection',...args),
    loadJudgeRunContext: (...args) => storage.command('loadJudgeRunContext',...args),
    recordJudgeRun: (...args) => storage.command('recordJudgeRun',...args),
    recordVerdict: (...args) => storage.command('recordVerdict',...args),
    listVerdicts: (...args) => storage.command('listVerdicts',...args),
    createFeedbackSyncJob: (...args) => storage.command('createFeedbackSyncJob',...args),

    createDataset: (...args) => storage.command('createDataset',...args),
    listDatasets: (...args) => storage.command('listDatasets',...args),
    getDatasetDetail: (...args) => storage.command('getDatasetDetail',...args),
    archiveDataset: (...args) => storage.command('archiveDataset',...args),
    addDatasetItems: (...args) => storage.command('addDatasetItems',...args),
    removeDatasetItem: (...args) => storage.command('removeDatasetItem',...args),

    importTrace: (...args) => storage.command('importTrace',...args),
    getCaseSourceIdentity: (...args) => storage.command('getCaseSourceIdentity',...args),
    caseExistsForProject: (...args) => storage.command('caseExistsForProject',...args),
    listCaseIdsForProject: (...args) => storage.command('listCaseIdsForProject',...args),
    listCases: (...args) => storage.command('listCases',...args),

    listCriteria: (...args) => storage.command('listCriteria',...args),
    getCriterion: (...args) => storage.command('getCriterion',...args),
    createCriterion: (...args) => storage.command('createCriterion',...args),
    createCriterionVersion: (...args) => storage.command('createCriterionVersion',...args),
    getSkillVersion: (...args) => storage.command('getSkillVersion',...args),
    getCriterionVersionForSkillVersion: (...args) => storage.command('getCriterionVersionForSkillVersion',...args),
    getCurrentSkill: (...args) => storage.command('getCurrentSkill',...args),
    getCurrentSkillForCriterion: (...args) => storage.command('getCurrentSkillForCriterion',...args),
    getLatestSkill: (...args) => storage.command('getLatestSkill',...args),
    getLatestSkillForCriterion: (...args) => storage.command('getLatestSkillForCriterion',...args),
    listSkillVersions: (...args) => storage.command('listSkillVersions',...args),
    authorizeSkillVersionExecution: (...args) => storage.command('authorizeSkillVersionExecution',...args),

    listProjects: (...args) => storage.command('listProjects',...args),
    getProjectSettings: (...args) => storage.command('getProjectSettings',...args),
    updateProjectSettings: (...args) => storage.command('updateProjectSettings',...args),
    deleteProject: (...args) => storage.command('deleteProject',...args),
    createApiKey: (...args) => storage.command('createApiKey',...args),
    listApiKeys: (...args) => storage.command('listApiKeys',...args),
    revokeApiKey: (...args) => storage.command('revokeApiKey',...args),
    resolveApiKey: (...args) => storage.command('resolveApiKey',...args),
    setJudgeProviderKey: (...args) => storage.command('setJudgeProviderKey',...args),
    listJudgeProviderKeys: (...args) => storage.command('listJudgeProviderKeys',...args),
    getJudgeProviderCredential: (...args) => storage.command('getJudgeProviderCredential',...args),
    deleteJudgeProviderKey: (...args) => storage.command('deleteJudgeProviderKey',...args)
  } satisfies Omit<RubristRepository,'createSkillVersion'|'runRegressionGateForVersion'|'failRegressionGateForVersion'|'getRegressionRunForVersion'|'listRegressionRunsForVersions'>;
  const repository:RubristRepository={...methods,...sqliteRegressionService(storage,methods,judgeProviderFactory)};
  return {storage,accounts,repository,analysisPopulations,analysisStudies,productionRecords,queue,capabilityChecks,resolution,auth:storage.auth(),close:async () => { await queue.stop(); await storage.close(); }};
}
