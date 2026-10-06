import { seedSqliteStarterEvaluator } from './starter-evaluator.js';
import { sqliteProductionCommands } from './production-commands.js';
import { sqliteRegressionCommands } from './regression-commands.js';
import { sqliteSkillCommands } from './skill-commands.js';
import { sqliteHistoricalGateCommands } from './historical-gate-commands.js';
import { sqliteProjectCommands } from './project-commands.js';
import { sqliteFeedbackCommands } from './feedback-commands.js';
import { sqliteImportJobCommands } from './import-job-commands.js';
import { sqliteIntegrationCommands } from './integration-commands.js';
import { sqliteTraceTestCommands } from './trace-test-commands.js';
import { sqliteGoldenCommands } from './golden-commands.js';
import { sqliteConvergenceCommands } from './convergence-commands.js';
import { sqliteEvidenceCommands } from './evidence-commands.js';
import { sqliteReviewCommands } from './review-commands.js';
import { sqliteResolutionCommands } from './resolution-commands.js';
import { sqliteSuiteCommands } from './suite-commands.js';
import { sqliteDatasetRevisionCommands } from './dataset-revision-commands.js';
import { sqliteEvalCommands } from './eval-commands.js';
import { sqliteJudgeCommands } from './judge-commands.js';
import { sqliteDatasetCommands } from './dataset-commands.js';
import { sqliteTraceCommands } from './trace-commands.js';
import { sqliteDefinitionCommands } from './definition-commands.js';
import { sqliteQueueCommands } from './queue-commands.js';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AccountServices } from '../../accounts/ports.js';
import { AgentSetupPairingInProgressError, AGENT_SETUP_PAIRING_CLAIM_GRACE_MS, type AgentSetupPairingRecord } from '../../lib/auth.js';
import { generateApiKey, hashApiKey } from '../../lib/api-keys.js';
import { judgeKeyDisplay } from '../../repository/helpers.js';
import { encryptJson, decryptJson } from '../../lib/encryption.js';
import { ApiKeySchema, ProjectSchema, ProjectSettingsSchema, type CreatedApiKey, type JudgeKeyProvider } from '@rubrist/shared';
import type { CreateApiKeyInputDb, RubristRepository } from '../../repository.js';

type Args<K extends keyof AccountServices> = Parameters<AccountServices[K]>;
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const now = () => new Date().toISOString();
const future = (ms: number) => new Date(Date.now()+ms).toISOString();
const openPairing = 'consumed_at IS NULL AND revoked_at IS NULL';

export function sqliteCommands(db: DatabaseSync, options:{seedStarterEvaluators?:boolean}={}) {
  const one = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params);
  const all = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params);
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);
  function transaction<T>(fn: () => T): T {
    if (db.isTransaction) throw new Error('Nested SQLite command');
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch(error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }
  function audit(projectId: string, actor: string | null, action: string, targetType: string, target: string, metadata: unknown) {
    run('INSERT INTO audit_logs VALUES(?,?,?,?,?,?,?,?)',id('audit'),projectId,actor,action,targetType,target,JSON.stringify(metadata),now());
  }
  function keyRow(row: Record<string,unknown>) {
    return ApiKeySchema.parse({id:row.id,projectId:row.project_id,name:row.name,keyPrefix:row.key_prefix,
      capability:row.capability,createdAt:row.created_at,lastUsedAt:row.last_used_at,revokedAt:row.revoked_at});
  }
  function insertKey(input: CreateApiKeyInputDb): CreatedApiKey {
    const generated = generateApiKey();
    const row = one(`INSERT INTO api_keys(id,project_id,name,key_hash,key_prefix,capability,created_by_user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?) RETURNING *`,id('apikey'),input.projectId,input.name,generated.keyHash,generated.keyPrefix,
      input.capability ?? 'judge',input.createdByUserId ?? null,now())!;
    return {...keyRow(row),key:generated.key};
  }
  function projectRow(row: Record<string,unknown>) {
    return ProjectSchema.parse({id:row.id,name:row.name,mode:row.mode,traceProvider:row.trace_provider,
      importedTraceCount:row.imported_trace_count,autoJudgedTraceCount:row.auto_judged_trace_count,
      syncBackCoverage:row.sync_back_coverage,traceRetentionDays:row.trace_retention_days,updatedAt:row.updated_at});
  }
  function settings(projectId: string) {
    const row = one('SELECT * FROM projects WHERE id=?',projectId);
    if (!row) throw new Error('Project not found');
    return ProjectSettingsSchema.parse({projectId:row.id,name:row.name,mode:row.mode,traceRetentionDays:row.trace_retention_days});
  }
  function createProject(input: Args<'createProjectForUser'>[0], role = 'owner', freshOrg = false) {
    let organizationId = freshOrg ? undefined : one('SELECT organization_id FROM organization_members WHERE user_id=? ORDER BY created_at,id LIMIT 1',input.userId)?.organization_id as string | undefined;
    if (!organizationId) {
      organizationId = id('org');
      run('INSERT INTO organizations VALUES(?,?,?)',organizationId,`${input.email.split('@')[0]}'s organization`,now());
      run('INSERT INTO organization_members VALUES(?,?,?,?,?)',id('orgmem'),organizationId,input.userId,role,now());
    }
    const projectId = id('proj');
    run('INSERT INTO projects(id,organization_id,name,mode,created_at,updated_at) VALUES(?,?,?,?,?,?)',projectId,organizationId,input.name,input.mode ?? 'tracing',now(),now());
    run('INSERT INTO project_members VALUES(?,?,?,?,?)',id('projmem'),projectId,input.userId,role,now());
    if(options.seedStarterEvaluators)seedSqliteStarterEvaluator(db,projectId,input.userId,input.mode??'tracing',now());
    const apiKey = input.apiKeyName ? insertKey({projectId,name:input.apiKeyName,createdByUserId:input.userId}) : undefined;
    return {organizationId,projectId,...(apiKey ? {apiKey} : {})};
  }
  const pairingSelect = `SELECT asp.*,p.name project_name,u.email owner_email,u.name owner_name FROM agent_setup_pairings asp
    JOIN projects p ON p.id=asp.project_id JOIN "user" u ON u.id=asp.created_by_user_id`;
  function pairing(row: Record<string,unknown> | undefined): AgentSetupPairingRecord | null {
    return row ? {id:String(row.id),projectId:String(row.project_id),projectName:String(row.project_name),
      createdByUserId:String(row.created_by_user_id),ownerEmail:String(row.owner_email),ownerName:String(row.owner_name),
      expiresAt:String(row.expires_at),claimedAt:row.claimed_at as string|null,consumedAt:row.consumed_at as string|null,revokedAt:row.revoked_at as string|null} : null;
  }
  const commands = {
    countUsers() { return Number(one('SELECT count(*) n FROM "user"')!.n); },
    setupRequired() { return commands.countUsers() === 0; },
    bootstrapOwnerUserByEmail(email: string) {
      const row = one(`SELECT id,email,name FROM "user" u WHERE email=? COLLATE NOCASE AND
        (EXISTS(SELECT 1 FROM organization_members WHERE user_id=u.id AND role='owner')
        OR NOT EXISTS(SELECT 1 FROM organization_members WHERE user_id=u.id))`,email);
      return row ? {id:String(row.id),email:String(row.email),name:String(row.name)} : null;
    },
    ensureWorkspaceForUser(input: Args<'ensureWorkspaceForUser'>[0]) {
      return transaction(() => {
        const existing = one(`SELECT p.id,p.organization_id,p.mode FROM projects p JOIN project_members pm ON pm.project_id=p.id
          WHERE pm.user_id=? ORDER BY p.created_at,p.id LIMIT 1`,input.userId);
        if(existing) {if(options.seedStarterEvaluators)seedSqliteStarterEvaluator(db,String(existing.id),input.userId,String(existing.mode),now());return {organizationId:String(existing.organization_id),projectId:String(existing.id)};}
        return createProject({...input,name:input.projectName?.trim() || 'Default Project'},input.owner ? 'owner':'member',true);
      });
    },
    createProjectForUser(input: Args<'createProjectForUser'>[0]) { return transaction(() => createProject(input)); },
    firstProjectForUser(userId: string) { return one('SELECT project_id FROM project_members WHERE user_id=? ORDER BY created_at,id LIMIT 1',userId)?.project_id as string ?? null; },
    userProjectRole(input: Args<'userProjectRole'>[0]) { return one('SELECT role FROM project_members WHERE project_id=? AND user_id=?',input.projectId,input.userId)?.role as string ?? null; },
    createInvitation(input: Args<'createInvitation'>[0]) {
      return transaction(() => {
        const project = one('SELECT organization_id FROM projects WHERE id=?',input.projectId);
        if (!project || commands.userProjectRole({projectId:input.projectId,userId:input.invitedByUserId}) !== 'owner') throw new Error('Project owner required');
        const token = randomBytes(32).toString('base64url');
        run(`INSERT INTO invitations(id,organization_id,project_id,email,token_hash,role,invited_by_user_id,expires_at,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,id('inv'),String(project.organization_id),input.projectId,input.email,hash(token),input.role,input.invitedByUserId,future(7*86400000),now());
        return {token};
      });
    },
    validateInvitation(token: string, email: string) {
      return Boolean(one('SELECT 1 FROM invitations WHERE token_hash=? AND email=? COLLATE NOCASE AND redeemed_at IS NULL AND expires_at>?',hash(token),email,now()));
    },
    redeemInvitation(input: Args<'redeemInvitation'>[0]) {
      return transaction(() => {
        const invitation = one(`SELECT i.* FROM invitations i JOIN "user" u ON lower(u.email)=lower(i.email)
          WHERE token_hash=? AND u.id=? AND redeemed_at IS NULL AND expires_at>?`,hash(input.token),input.userId,now());
        if (!invitation) throw new Error('Invalid or expired invite token');
        run('INSERT INTO organization_members VALUES(?,?,?,?,?) ON CONFLICT(organization_id,user_id) DO NOTHING',id('orgmem'),String(invitation.organization_id),input.userId,String(invitation.role),now());
        run('INSERT INTO project_members VALUES(?,?,?,?,?) ON CONFLICT(project_id,user_id) DO NOTHING',id('projmem'),String(invitation.project_id),input.userId,String(invitation.role),now());
        run('UPDATE invitations SET redeemed_at=?,redeemed_by_user_id=? WHERE id=?',now(),input.userId,String(invitation.id));
        return {projectId:String(invitation.project_id),role:String(invitation.role)};
      });
    },
    pairingEligibility(projectId: string) {
      const row = one('SELECT imported_trace_count,setup_state FROM projects WHERE id=?',projectId);
      if (!row) return null;
      if(Number(row.imported_trace_count)>0)return 'project_not_empty' as const;
      const skills=one('SELECT count(*) n,coalesce(sum(is_starter),0) starters FROM skills WHERE project_id=?',projectId)!;
      return options.seedStarterEvaluators ? (Number(skills.n)===1&&Number(skills.starters)===1?'eligible' as const:'project_already_configured' as const) : row.setup_state==='unconfigured'?'eligible' as const:'project_already_configured' as const;
    },
    createAgentSetupPairing(input: Args<'createAgentSetupPairing'>[0]) {
      return transaction(() => {
        if (commands.userProjectRole({userId:input.createdByUserId,projectId:input.projectId}) !== 'owner') throw new Error('Project owner required');
        if (commands.pairingEligibility(input.projectId) !== 'eligible') throw new Error('Project is not eligible for pairing');
        if (one(`SELECT id FROM agent_setup_pairings WHERE project_id=? AND ${openPairing} AND claimed_at>?`,input.projectId,future(-AGENT_SETUP_PAIRING_CLAIM_GRACE_MS))) throw new AgentSetupPairingInProgressError();
        run(`UPDATE agent_setup_pairings SET revoked_at=?,claimed_at=NULL WHERE project_id=? AND ${openPairing}`,now(),input.projectId);
        const token = `rubrist_pair_${randomBytes(32).toString('base64url')}`;
        const pairingId = id('pair');
        run('INSERT INTO agent_setup_pairings(id,project_id,created_by_user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)',pairingId,input.projectId,input.createdByUserId,hash(token),future(15*60000),now());
        return {...commands.getAgentSetupPairing({id:pairingId,projectId:input.projectId})!,token};
      });
    },
    getAgentSetupPairing(input: Args<'getAgentSetupPairing'>[0]) { return pairing(one(`${pairingSelect} WHERE asp.id=? AND asp.project_id=?`,input.id,input.projectId)); },
    resolveAgentSetupPairing(token: string) {
      return pairing(one(`${pairingSelect} WHERE asp.token_hash=? AND asp.expires_at>? AND asp.consumed_at IS NULL AND asp.revoked_at IS NULL
        AND EXISTS(SELECT 1 FROM project_members WHERE project_id=asp.project_id AND user_id=asp.created_by_user_id AND role='owner')`,hash(token),now()));
    },
    claimAgentSetupPairing(pairingId: string) {
      return run(`UPDATE agent_setup_pairings SET claimed_at=? WHERE id=? AND expires_at>? AND ${openPairing} AND claimed_at IS NULL
        AND EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=agent_setup_pairings.project_id AND pm.user_id=created_by_user_id AND pm.role='owner')`,now(),pairingId,now()).changes > 0;
    },
    releaseAgentSetupPairing(pairingId: string) { run(`UPDATE agent_setup_pairings SET claimed_at=NULL WHERE id=? AND ${openPairing}`,pairingId); },
    completeAgentSetupPairing(pairingId: string) { return run(`UPDATE agent_setup_pairings SET consumed_at=?,claimed_at=NULL WHERE id=? AND ${openPairing}`,now(),pairingId).changes > 0; },
    invalidateAgentSetupPairing(pairingId: string) { run(`UPDATE agent_setup_pairings SET revoked_at=?,claimed_at=NULL WHERE id=? AND ${openPairing}`,now(),pairingId); },
    revokeAgentSetupPairing(input: Args<'revokeAgentSetupPairing'>[0]) { return run(`UPDATE agent_setup_pairings SET revoked_at=?,claimed_at=NULL WHERE id=? AND project_id=? AND ${openPairing} AND (claimed_at IS NULL OR claimed_at<=?)`,now(),input.id,input.projectId,future(-AGENT_SETUP_PAIRING_CLAIM_GRACE_MS)).changes > 0; },
    listProjects(userId?: string) {
      if (!userId) throw new Error('Project list requires a user');
      return all('SELECT p.* FROM projects p JOIN project_members pm ON pm.project_id=p.id WHERE pm.user_id=? ORDER BY p.created_at,p.id',userId).map(projectRow);
    },
    getProjectSettings: settings,
    updateProjectSettings(projectId: string, input: Parameters<RubristRepository['updateProjectSettings']>[1], context: {actorUserId?: string|undefined}) {
      return transaction(() => {
        settings(projectId);
        run('UPDATE projects SET trace_retention_days=?,mode=coalesce(?,mode),updated_at=? WHERE id=?',input.traceRetentionDays,input.mode ?? null,now(),projectId);
        audit(projectId,context.actorUserId ?? null,'project.retention.update','project',projectId,input);
        return settings(projectId);
      });
    },
    deleteProject(projectId: string, input: Parameters<RubristRepository['deleteProject']>[1]) {
      transaction(() => {
        if (settings(projectId).name !== input.confirmProjectName) throw new Error('Project name confirmation did not match');
        run("UPDATE audit_logs SET metadata=json_set(metadata,'$.deletedProjectId',?),project_id=NULL WHERE project_id=?",projectId,projectId);
        audit(projectId,input.actorUserId ?? null,'project.delete','project',projectId,{deletedProjectId:projectId,projectName:input.confirmProjectName});
        run('DELETE FROM projects WHERE id=?',projectId);
      });
    },
    createApiKey(input: CreateApiKeyInputDb) { return insertKey(input); },
    listApiKeys(projectId: string) { return all('SELECT * FROM api_keys WHERE project_id=? ORDER BY created_at DESC,id',projectId).map(keyRow); },
    revokeApiKey(projectId: string,keyId: string) { return run('UPDATE api_keys SET revoked_at=? WHERE project_id=? AND id=? AND revoked_at IS NULL',now(),projectId,keyId).changes>0; },
    resolveApiKey(rawKey: string) {
      const row = one('UPDATE api_keys SET last_used_at=? WHERE key_hash=? AND revoked_at IS NULL RETURNING id,project_id,capability',now(),hashApiKey(rawKey));
      return row ? {projectId:String(row.project_id),apiKeyId:String(row.id),capability:row.capability as 'judge'|'production_ingest'} : null;
    },
    setJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, apiKey: string, actor?: string) {
      return transaction(() => {
        const createdAt = now(); const keyDisplay = judgeKeyDisplay(apiKey);
        run('INSERT INTO judge_provider_keys VALUES(?,?,?,?,?) ON CONFLICT(project_id,provider) DO UPDATE SET encrypted_credentials=excluded.encrypted_credentials,key_display=excluded.key_display,created_at=excluded.created_at',projectId,provider,encryptJson({apiKey}),keyDisplay,createdAt);
        audit(projectId,actor ?? null,'project.judge_key.set','judge_provider_key',provider,{provider});
        return {provider,keyDisplay,createdAt};
      });
    },
    listJudgeProviderKeys(projectId: string) { return all('SELECT provider,key_display,created_at FROM judge_provider_keys WHERE project_id=? ORDER BY provider',projectId).map(row => ({provider:row.provider as JudgeKeyProvider,keyDisplay:String(row.key_display),createdAt:String(row.created_at)})); },
    getJudgeProviderCredential(projectId: string, provider: string) { const row=one('SELECT encrypted_credentials FROM judge_provider_keys WHERE project_id=? AND provider=?',projectId,provider); return row ? decryptJson<{apiKey:string}>(String(row.encrypted_credentials)).apiKey : null; },
    deleteJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, actor?: string) { return transaction(() => {
      const removed = run('DELETE FROM judge_provider_keys WHERE project_id=? AND provider=?',projectId,provider).changes>0;
      if (removed) audit(projectId,actor ?? null,'project.judge_key.removed','judge_provider_key',provider,{provider}); return removed;
    }); },
    recordCaseView(input: Args<'recordCaseView'>[0]) { audit(input.projectId,input.userId,'case.view','case',input.caseId,{traceId:input.traceId}); }
  };
  return {...commands, ...sqliteProductionCommands(db), ...sqliteRegressionCommands(db), ...sqliteSkillCommands(db), ...sqliteHistoricalGateCommands(db), ...sqliteProjectCommands(db), ...sqliteFeedbackCommands(db), ...sqliteImportJobCommands(db),
    ...sqliteIntegrationCommands(db),
    ...sqliteTraceTestCommands(db),
    ...sqliteGoldenCommands(db), ...sqliteConvergenceCommands(db), ...sqliteEvidenceCommands(db), ...sqliteReviewCommands(db), ...sqliteResolutionCommands(db), ...sqliteQueueCommands(db), ...sqliteDefinitionCommands(db), ...sqliteTraceCommands(db), ...sqliteDatasetCommands(db), ...sqliteSuiteCommands(db), ...sqliteDatasetRevisionCommands(db), ...sqliteEvalCommands(db), ...sqliteJudgeCommands(db)};
}
export type SqliteCommands = ReturnType<typeof sqliteCommands>;
