import type * as pg from '../lib/auth.js';

// Derive the existing account contract; SQL and transactions stay backend-specific.
type AccountMethod =
  | 'countUsers' | 'setupRequired' | 'bootstrapOwnerUserByEmail'
  | 'ensureWorkspaceForUser' | 'createProjectForUser' | 'createInvitation' | 'redeemInvitation'
  | 'validateInvitation' | 'userProjectRole' | 'firstProjectForUser' | 'createAgentSetupPairing' | 'resolveAgentSetupPairing'
  | 'claimAgentSetupPairing' | 'releaseAgentSetupPairing' | 'completeAgentSetupPairing'
  | 'invalidateAgentSetupPairing' | 'revokeAgentSetupPairing' | 'getAgentSetupPairing';
// A concrete Pool parameter is intentionally removed rather than abstracted as SQL.
export type AccountServices = {
  [K in AccountMethod]: typeof pg[K] extends (db: any, ...args: infer A) => infer R ? (...args: A) => R : never;
} & {
  withSetupLock<T>(work: () => Promise<T>): Promise<T>;
  pairingEligibility(projectId: string): Promise<'eligible' | 'project_not_empty' | 'project_already_configured' | null>;
  recordCaseView(input: { projectId: string; userId: string | null; caseId: string; traceId: string }): Promise<void>;
};
