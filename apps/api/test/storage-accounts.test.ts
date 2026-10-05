import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { runMigrations } from '@rubrist/db';
import { openSqlite } from '@rubrist/db/sqlite';
import { createApp, type RubristApi } from '../src/app.js';
import { createAuth, type RubristAuth } from '../src/lib/auth.js';
import { createPgAccountServices } from '../src/accounts/postgres.js';
import type { AccountServices } from '../src/accounts/ports.js';
import { createSqliteRuntime } from '../src/storage/sqlite/runtime.js';
import type { RubristRepository } from '../src/repository.js';
import { PgRepository } from '../src/repository.pg.js';
import { openPostgresTestDatabase } from './helpers/postgres.js';

const secret = 'synthetic-sqlite-and-postgres-contract-secret-32-bytes';
const password = 'synthetic-test-password';
const cookieOf = (r: Response) => r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const json = (body: unknown, cookie = '', projectId = '') => ({
  method: 'POST', headers: { 'content-type': 'application/json', cookie, ...(projectId ? {'x-rubrist-project':projectId} : {}) },
  body: JSON.stringify(body)
});
interface Fixture {
  app: RubristApi; accounts: AccountServices; repository: RubristRepository; auth: RubristAuth;
  sql(query: string, values?: string[]): Promise<Record<string, any>[]>;
  restart(): Promise<void>; close(): Promise<void>;
}
async function fixture(kind: 'sqlite' | 'postgres'): Promise<Fixture> {
  if (kind === 'sqlite') {
    const dir = mkdtempSync(`${tmpdir()}/rubrist-accounts-`);
    const path = `${dir}/accounts.sqlite`;
    let runtime = await createSqliteRuntime(path);
    const app = () => createApp(runtime.repository,{auth:runtime.auth,accounts:runtime.accounts,runtimeMode:'persistent',accountStage:true});
    const value: Fixture = {
      ...runtime, app:app(),
      async sql(query, values = []) { const db = openSqlite(path); try { return db.prepare(query).all(...values); } finally { db.close(); } },
      async restart() { await runtime.close(); runtime = await createSqliteRuntime(path); Object.assign(value,runtime,{app:app()}); },
      async close() { await runtime.close(); rmSync(dir,{recursive:true,force:true}); }
    };
    // Runtime spread includes close; preserve the fixture's cleanup across restart.
    const close = value.close;
    const restart = value.restart;
    value.restart = async () => { await restart(); value.close=close; };
    return value;
  }
  const database = await openPostgresTestDatabase('storage_accounts');
  let pool = new Pool({connectionString:database.databaseUrl});
  await runMigrations(pool);
  const compose = () => {
    const repository = new PgRepository(pool), auth = createAuth(pool), accounts = createPgAccountServices(pool);
    return {repository,auth,accounts,app:createApp(repository,{pool,auth,accounts,runtimeMode:'persistent'})};
  };
  const value: Fixture = {
    ...compose(),
    async sql(query, values = []) { let i=0; return (await pool.query(query.replaceAll('?',() => `$${++i}`),values)).rows; },
    async restart() { await pool.end(); pool = new Pool({connectionString:database.databaseUrl}); Object.assign(value,compose()); },
    async close() { if (pool !== database.pool) await pool.end(); await database.cleanup(); }
  };
  return value;
}

for (const kind of ['sqlite','postgres'] as const) {
  describe.skipIf(kind === 'postgres' && !process.env.PG_SMOKE_DATABASE_URL)(`${kind} persistent account contract`, () => {
    let f: Fixture;
    beforeEach(async () => { process.env.BETTER_AUTH_SECRET = secret; f = await fixture(kind); });
    afterEach(async () => { await f?.close(); });
    async function setup() {
      const r = await f.app.request('/api/auth/setup',json({email:'owner@example.com',password,name:'Owner',projectName:'Synthetic project',mode:'bench'}));
      expect(r.status,await r.clone().text()).toBe(200);
      return {cookie:cookieOf(r),...await r.json() as {projectId:string;apiKey:{id:string;key:string}}};
    }
    async function invite(cookie: string, email: string) {
      const r = await f.app.request('/api/users/invite',json({email,role:'member'},cookie));
      expect(r.status,await r.clone().text()).toBe(201);
      return (await r.json() as {token:string}).token;
    }
    it('serializes first-owner creation, persists browser sessions, logs out and fails closed', async () => {
      expect(await (await f.app.request('/api/auth/setup-required')).json()).toEqual({setupRequired:true,authEnabled:true});
      expect((await f.app.request('/api/projects')).status).toBe(401);
      expect((await f.app.request('/api/auth/sign-up/email',json({email:'public@example.com',password,name:'Public'}))).status).toBe(403);
      const responses = await Promise.all(['owner@example.com','loser@example.com'].map(email => f.app.request('/api/auth/setup',json({email,password}))));
      expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
      expect(await f.accounts.countUsers()).toBe(1);
      const winner = responses.find(r=>r.status===200)!;
      const cookie = cookieOf(winner);
      expect(cookie).toContain('better-auth');
      await f.restart();
      expect(await (await f.app.request('/api/auth/setup-required')).json()).toEqual({setupRequired:false,authEnabled:true});
      expect((await f.app.request('/api/projects',{headers:{cookie}})).status).toBe(200);
      const signout = await f.app.request('/api/auth/sign-out',json({},cookie));
      expect(signout.status,await signout.clone().text()).toBe(200);
      expect((await f.app.request('/api/projects',{headers:{cookie}})).status).toBe(401);
      const signin = await f.app.request('/api/auth/sign-in/email',json({email:responses[0]!.status === 200 ? 'owner@example.com' : 'loser@example.com',password}));
      expect(signin.status,await signin.clone().text()).toBe(200);
      expect((await f.app.request('/api/projects',{headers:{cookie:cookieOf(signin)}})).status).toBe(200);
    });
    it('binds invites to email, protects tenant/owner operations, persists encrypted credentials and revokes keys', async () => {
      const owner = await setup();
      const token = await invite(owner.cookie,'member@example.com');
      for (const input of [{token:'bad-token-123',email:'intruder@example.com'},{token,email:'intruder@example.com'}]) {
        expect((await f.app.request('/api/auth/redeem-invite',json({...input,password}))).status).toBe(400);
      }
      expect(await f.accounts.countUsers()).toBe(1);
      const redemption = await f.app.request('/api/auth/redeem-invite',json({token,email:'member@example.com',password}));
      expect(redemption.status,await redemption.clone().text()).toBe(200);
      const member = cookieOf(redemption);
      expect((await f.app.request('/api/auth/redeem-invite',json({token,email:'member@example.com',password}))).status).toBe(400);
      const second = await f.app.request('/api/projects',json({name:'Private project'},owner.cookie));
      expect(second.status).toBe(201);
      const secondId = (await second.json() as {projectId:string}).projectId;
      expect((await f.app.request('/api/project/settings',{headers:{cookie:member,'x-rubrist-project':secondId}})).status).toBe(403);
      const visible = await (await f.app.request('/api/projects',{headers:{cookie:member}})).json() as {projects:{id:string}[]};
      expect(visible.projects.map(p=>p.id)).toEqual([owner.projectId]);
      expect((await f.app.request('/api/api-keys',json({name:'Forbidden'},member))).status).toBe(403);
      expect((await f.app.request('/api/users/invite',json({email:'other@example.com'},member))).status).toBe(403);
      expect((await f.app.request('/api/agent-setup/pairings',json({},member))).status).toBe(403);
      const key = 'sk-synthetic-provider-secret-abcdefgh';
      const save = await f.app.request('/api/judge-keys/openai',{...json({apiKey:key},owner.cookie),method:'PUT'});
      expect(save.status,await save.clone().text()).toBe(201);
      expect((await f.app.request('/api/judge-keys',{headers:{cookie:member}})).status).toBe(403);
      expect((await f.app.request('/api/judge-keys')).status).toBe(401);
      const ownerKeys = await f.app.request('/api/judge-keys',{headers:{cookie:owner.cookie}});
      expect(ownerKeys.status).toBe(200);
      expect(await ownerKeys.json()).toMatchObject({keys:[{provider:'openai',keyDisplay:'sk-synthet…efgh'}]});
      const rows = await f.sql('select * from judge_provider_keys where project_id=?',[owner.projectId]);
      expect(JSON.stringify(rows)).not.toContain(key);
      expect(await f.repository.getJudgeProviderCredential(owner.projectId,'openai')).toBe(key);
      await f.restart();
      expect(await f.repository.getJudgeProviderCredential(owner.projectId,'openai')).toBe(key);
      const listed = await (await f.app.request('/api/api-keys',{headers:{cookie:owner.cookie}})).text();
      expect(listed).not.toContain(owner.apiKey.key);
      expect(await f.repository.resolveApiKey(owner.apiKey.key)).toMatchObject({projectId:owner.projectId});
      const revoke = await f.app.request(`/api/api-keys/${owner.apiKey.id}`,{method:'DELETE',headers:{cookie:owner.cookie}});
      expect(revoke.status).toBe(200);
      expect(await f.repository.resolveApiKey(owner.apiKey.key)).toBeNull();
      expect((await f.app.request('/api/v1/project',{headers:{authorization:`Bearer ${owner.apiKey.key}`}})).status).toBe(401);
      if (kind === 'sqlite') {
        const blocked = await f.app.request('/api/dashboard',{headers:{cookie:owner.cookie}});
        expect(blocked.status).toBe(503);
        expect(await blocked.json()).toMatchObject({code:'sqlite_feature_unavailable'});
        // Secret is captured by the worker at startup; a wrong restart secret cannot decrypt.
        process.env.BETTER_AUTH_SECRET = `${secret}-wrong`;
        await f.restart();
        await expect(f.repository.getJudgeProviderCredential(owner.projectId,'openai')).rejects.toThrow();
      }
    });
    it('enforces expired and one-use invitations and recovers an orphan owner without duplicate projects', async () => {
      const owner = await setup();
      const token = await invite(owner.cookie,'race@example.com');
      const user = await f.auth.api.signUpEmail({body:{email:'race@example.com',password,name:'Race'}});
      const race = await Promise.allSettled([1,2].map(()=>f.accounts.redeemInvitation({token,userId:user.user.id})));
      expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);
      const expired = await invite(owner.cookie,'expired@example.com');
      await f.sql("update invitations set expires_at='2000-01-01T00:00:00.000Z' where email='expired@example.com'");
      expect((await f.app.request('/api/auth/redeem-invite',json({token:expired,email:'expired@example.com',password}))).status).toBe(400);
      const orphan = await f.auth.api.signUpEmail({body:{email:'orphan@example.com',password,name:'Orphan'}});
      expect(await f.accounts.bootstrapOwnerUserByEmail('orphan@example.com')).toMatchObject({id:orphan.user.id});
      const input = {userId:orphan.user.id,email:orphan.user.email,owner:true,apiKeyName:'Recovered key'};
      // PG helper lacks idempotency under a direct command race; the setup service lock owns that boundary.
      const recovered = await f.accounts.withSetupLock(()=>f.accounts.ensureWorkspaceForUser(input));
      const retried = await f.accounts.withSetupLock(()=>f.accounts.ensureWorkspaceForUser(input));
      expect(retried.projectId).toBe(recovered.projectId);
      expect(await f.repository.listApiKeys(recovered.projectId)).toHaveLength(1);
    });
    it('recovers through login and project creation when setup stops after creating the auth user', async () => {
      const interrupted = createApp(f.repository,{
        auth:f.auth, runtimeMode:'persistent', accountStage:kind === 'sqlite',
        accounts:{...f.accounts,async ensureWorkspaceForUser() { throw new Error('Synthetic interruption before workspace commit'); }}
      });
      expect((await interrupted.request('/api/auth/setup',json({email:'recover@example.com',password}))).status).toBe(500);
      expect(await f.accounts.countUsers()).toBe(1);
      await f.restart();
      const login = await f.app.request('/api/auth/sign-in/email',json({email:'recover@example.com',password}));
      expect(login.status).toBe(200);
      const cookie=cookieOf(login);
      const empty = await f.app.request('/api/projects',{headers:{cookie}});
      expect(await empty.json()).toEqual({projects:[]});
      const recovery = await f.app.request('/api/projects',json({name:'Recovered workspace'},cookie));
      expect(recovery.status,await recovery.clone().text()).toBe(201);
      expect((await recovery.json() as {apiKey:{key:string}}).apiKey.key).toMatch(/^rubrist_sk_/);
    });
    it('deletes a project with attributed audit history and allows creating a replacement', async () => {
      const owner = await setup();
      await f.repository.setJudgeProviderKey(owner.projectId,'openai','sk-synthetic-deleted-project-key');
      const deleted = await f.app.request('/api/project',{...json({confirmProjectName:'Synthetic project'},owner.cookie),method:'DELETE'});
      expect(deleted.status,await deleted.clone().text()).toBe(200);
      expect(await f.repository.resolveApiKey(owner.apiKey.key)).toBeNull();
      const audits = await f.sql('select project_id,action,metadata from audit_logs');
      expect(audits.length).toBeGreaterThanOrEqual(2);
      for (const row of audits) {
        expect(row.project_id).toBeNull();
        expect(typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata).toMatchObject({deletedProjectId:owner.projectId});
      }
      expect(audits.some(row=>row.action==='project.delete')).toBe(true);
      expect((await f.app.request('/api/projects',json({name:'Recovered after deletion'},owner.cookie))).status).toBe(201);
    });
    it('claims pairing once, protects an active claim, expires/replaces/revokes and consumes once', async () => {
      const owner = await setup();
      const creator = (await f.accounts.bootstrapOwnerUserByEmail('owner@example.com'))!.id;
      const create = () => f.accounts.createAgentSetupPairing({projectId:owner.projectId,createdByUserId:creator});
      const first = await create();
      expect(await f.accounts.resolveAgentSetupPairing(first.token)).toMatchObject({id:first.id});
      expect(JSON.stringify(await f.sql('select * from agent_setup_pairings'))).not.toContain(first.token);
      const claims = await Promise.all([f.accounts.claimAgentSetupPairing(first.id),f.accounts.claimAgentSetupPairing(first.id)]);
      expect(claims.sort()).toEqual([false,true]);
      await expect(create()).rejects.toThrow(/already running/i);
      expect(await f.accounts.revokeAgentSetupPairing({id:first.id,projectId:owner.projectId})).toBe(false);
      await f.sql("update agent_setup_pairings set claimed_at='2000-01-01T00:00:00.000Z' where id=?",[first.id]);
      const replacement = await create();
      expect(await f.accounts.resolveAgentSetupPairing(first.token)).toBeNull();
      expect(await f.accounts.claimAgentSetupPairing(replacement.id)).toBe(true);
      expect(await f.accounts.completeAgentSetupPairing(replacement.id)).toBe(true);
      expect(await f.accounts.completeAgentSetupPairing(replacement.id)).toBe(false);
      expect(await f.accounts.resolveAgentSetupPairing(replacement.token)).toBeNull();
      const expired = await create();
      await f.sql("update agent_setup_pairings set expires_at='2000-01-01T00:00:00.000Z' where id=?",[expired.id]);
      expect(await f.accounts.resolveAgentSetupPairing(expired.token)).toBeNull();
      expect(await f.accounts.claimAgentSetupPairing(expired.id)).toBe(false);
      const revoked = await create();
      expect(await f.accounts.revokeAgentSetupPairing({id:revoked.id,projectId:owner.projectId})).toBe(true);
      expect(await f.accounts.resolveAgentSetupPairing(revoked.token)).toBeNull();
    });
  });
}
