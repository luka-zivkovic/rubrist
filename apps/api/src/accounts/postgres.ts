import { randomUUID } from 'node:crypto';
import { Client, type Pool } from 'pg';
import * as auth from '../lib/auth.js';
import type { AccountServices } from './ports.js';

const setupWaiters = new WeakMap<Pool, Promise<void>>();

export function createPgAccountServices(pool: Pool): AccountServices {
  return {
    countUsers: (...args) => auth.countUsers(pool, ...args),
    setupRequired: (...args) => auth.setupRequired(pool, ...args),
    bootstrapOwnerUserByEmail: (...args) => auth.bootstrapOwnerUserByEmail(pool, ...args),
    ensureWorkspaceForUser: (...args) => auth.ensureWorkspaceForUser(pool, ...args),
    createProjectForUser: (...args) => auth.createProjectForUser(pool, ...args),
    createInvitation: (...args) => auth.createInvitation(pool, ...args),
    validateInvitation: (...args) => auth.validateInvitation(pool, ...args),
    redeemInvitation: (...args) => auth.redeemInvitation(pool, ...args),
    userProjectRole: (...args) => auth.userProjectRole(pool, ...args),
    firstProjectForUser: (...args) => auth.firstProjectForUser(pool, ...args),
    createAgentSetupPairing: (...args) => auth.createAgentSetupPairing(pool, ...args),
    resolveAgentSetupPairing: (...args) => auth.resolveAgentSetupPairing(pool, ...args),
    claimAgentSetupPairing: (...args) => auth.claimAgentSetupPairing(pool, ...args),
    releaseAgentSetupPairing: (...args) => auth.releaseAgentSetupPairing(pool, ...args),
    completeAgentSetupPairing: (...args) => auth.completeAgentSetupPairing(pool, ...args),
    invalidateAgentSetupPairing: (...args) => auth.invalidateAgentSetupPairing(pool, ...args),
    revokeAgentSetupPairing: (...args) => auth.revokeAgentSetupPairing(pool, ...args),
    getAgentSetupPairing: (...args) => auth.getAgentSetupPairing(pool, ...args),
    withSetupLock(work) {
      const result = (setupWaiters.get(pool) ?? Promise.resolve()).then(async () => {
        // The lock must not consume a pool slot needed by auth or workspace
        // commands, even with max=1. Local waiters share one connection;
        // PostgreSQL's session lock also serializes other application processes.
        const client = new Client(pool.options);
        let connectionFailure: Error | null = null;
        client.on('error', (error: Error) => { connectionFailure ??= error; });
        try {
          await client.connect();
          await client.query('select pg_advisory_lock(918273646)');
          const value = await work();
          // Keep local serialization until work settles even if the lock
          // connection fails. Do not report success after losing that session.
          if (connectionFailure) throw connectionFailure;
          return value;
        } finally {
          // Closing the dedicated session releases its advisory lock on every
          // path; it can never be returned to the pool with a retained lock.
          await client.end();
        }
      });
      setupWaiters.set(pool, result.then(() => undefined, () => undefined));
      return result;
    },
    async pairingEligibility(projectId) {
      const result = await pool.query(`select imported_trace_count,
        (select count(*) from skills where project_id=p.id) as skills,
        (select count(*) from skills where project_id=p.id and is_starter) as starters
        from projects p where id=$1`, [projectId]);
      const row = result.rows[0];
      if (!row) return null;
      if (Number(row.imported_trace_count) > 0) return 'project_not_empty';
      return Number(row.skills) === 1 && Number(row.starters) === 1 ? 'eligible' : 'project_already_configured';
    },
    async recordCaseView(input) {
      await pool.query(`insert into audit_logs (id,project_id,actor_user_id,action,target_type,target_id,metadata)
        values ($1,$2,$3,'case.view','case',$4,$5)`,
        [`audit_${randomUUID()}`, input.projectId,input.userId,input.caseId,JSON.stringify({traceId:input.traceId})]);
    }
  };
}
