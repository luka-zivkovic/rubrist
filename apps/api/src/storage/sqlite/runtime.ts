import { SqliteQueue } from '@rubrist/queue/sqlite';
import type { AccountServices } from '../../accounts/ports.js';
import type { RubristRepository } from '../../repository.js';
import { SqliteStorage } from './client.js';

export class SqliteFeatureUnavailableError extends Error {
  constructor() { super('This workflow is not yet available in the SQLite account-stage runtime.'); }
}
export async function createSqliteRuntime(path: string) {
  const storage = new SqliteStorage(path);
  try { await storage.ready; } catch(error) { await storage.close(); throw error; }
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
  } satisfies Partial<RubristRepository>;
  // The temporary account-stage adapter fails every unported method. Never
  // extend DemoRepository or return fabricated project/evaluator evidence.
  const repository = new Proxy(methods,{
    get(target,key,receiver) {
      if (Reflect.has(target,key)) return Reflect.get(target,key,receiver);
      if (key === 'then') return undefined;
      return async () => { throw new SqliteFeatureUnavailableError(); };
    }
  }) as RubristRepository;
  return {storage,accounts,repository,queue,auth:storage.auth(),close:async () => { await queue.stop(); await storage.close(); }};
}
