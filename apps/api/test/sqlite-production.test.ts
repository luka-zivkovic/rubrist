import { buildProductionCalibrationArtifact, joinProductionDecisionRecords, type ProductionDecisionRecord, type ProductionOutcomeRecord } from '@rubrist/shared';
import { ProductionRecordRepositoryError } from '../src/production-calibration/repository.js';
import { canonicalJson } from '../src/lib/canonical-json.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '@rubrist/db/sqlite';
import { createUnseededSqliteRuntime as createSqliteRuntime } from './helpers/sqlite.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { datasetInputIdentity } from '../src/lib/dataset-revision.js';
import { DatasetRevisionConflictError, SealedValidationUnavailableError } from '../src/repository/errors.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
async function fixture() {
  vi.stubEnv('BETTER_AUTH_SECRET','sqlite-revision-test-secret-at-least-32-characters');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-revisions-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'),runtime=await createSqliteRuntime(path);cleanup.push(()=>runtime.close());
  const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
  const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
  const r=runtime.repository,dataset=await r.createDataset({projectId,name:'Examples'});
  const db=openSqlite(path);cleanup.push(()=>db.close());sqliteCommands(db);
  return {path,runtime,r,projectId,dataset,db,user,p:runtime.productionRecords};
}


const digest=(c:string)=>`sha256:${c.repeat(64)}`;
function decision(id:string,probability=0.8,at='2026-09-20T10:00:00.000Z'):ProductionDecisionRecord {return {kind:'decision',id,at,questionSet:{name:'triage',version:1,digest:digest('a')},model:'synthetic-model',provider:'typesafe',stateDigest:digest('b'),stateLength:10,answers:{is_flaky:{type:'boolean',probability}},latencyMs:null,usage:null};}
function outcome(decisionId:string,at='2026-09-20T11:00:00.000Z'):ProductionOutcomeRecord {return {kind:'outcome',decisionId,at,question:'is_flaky',value:true,source:'human'};}
it('stores monitoring records atomically, deduplicates concurrent writes and joins out-of-order outcomes',async()=>{
 const f=await fixture(),input={projectId:f.projectId,submitter:{kind:'user' as const,userId:f.user.id}};
 expect(await f.p.appendRecords({...input,records:[outcome('decision')]})).toMatchObject({awaitingDecision:1});
 const peer=await createSqliteRuntime(f.path);cleanup.push(()=>peer.close());
 const results=await Promise.all([f.p,peer.productionRecords].map(p=>p.appendRecords({...input,records:[decision('decision'),outcome('decision')]})));
 expect(results.reduce((n,r)=>n+r.inserted.decisions,0)).toBe(1);expect(results.every(r=>r.awaitingDecision===0)).toBe(true);
 await expect(f.p.appendRecords({...input,records:[decision('another'),decision('decision',0.2)]})).rejects.toMatchObject({code:'conflicting_decision',details:{line:2,decisionId:'decision'}});
 const load={projectId:f.projectId,window:{from:null,to:null},maxRecords:10};expect((await f.p.loadRecords(load)).records).toHaveLength(2);
 await expect(f.p.appendRecords({...input,records:[decision('future',0.8,new Date(Date.now()+3600000).toISOString())]})).rejects.toBeInstanceOf(ProductionRecordRepositoryError);
 await expect(f.p.loadRecords({...load,maxRecords:1})).rejects.toMatchObject({code:'record_ceiling_exceeded',details:{maximum:1,from:null,to:null}});
 expect((await f.p.loadRecords({...load,projectId:'other'})).records).toEqual([]);
 expect(f.db.prepare('SELECT count(*) n FROM cases').get()?.n).toBe(0);expect(f.db.prepare('SELECT count(*) n FROM dataset_exposure_events').get()?.n).toBe(0);
 expect(()=>f.db.exec("UPDATE production_decision_records SET decision_id='changed'")).toThrow(/immutable/);expect(()=>f.db.exec('DELETE FROM production_decision_records')).toThrow(/audited/);
});
it('retains exact monitoring snapshot bytes across restart and receive-time retention',async()=>{
 const f=await fixture(),input={projectId:f.projectId,submitter:{kind:'user' as const,userId:f.user.id}};
 await f.p.appendRecords({...input,records:[decision('d'),outcome('d','2026-09-25T10:00:00.000Z'),outcome('orphan')]});
 const loaded=await f.p.loadRecords({projectId:f.projectId,window:{from:new Date('2026-09-20'),to:new Date('2026-09-21')},maxRecords:10});expect(loaded.records).toHaveLength(3);
 const artifact=buildProductionCalibrationArtifact(loaded.records,{now:new Date()}),saved=await f.p.saveSnapshot({projectId:f.projectId,userId:f.user.id,artifact,parameters:{bins:10},recordCount:3,recordSetDigest:loaded.recordSetDigest});
 const original=f.db.prepare('SELECT canonical_bytes FROM production_calibration_snapshots WHERE id=?').get(saved.id)!.canonical_bytes as Uint8Array;expect(Buffer.from(original).toString('utf8')).toBe(canonicalJson(artifact));
 await f.p.setRetentionDays({projectId:f.projectId,userId:f.user.id,retentionDays:1});
 expect((await f.p.applyRetention(new Date())).projects).toEqual([]);
 f.db.exec("CREATE TRIGGER reject_production_retention BEFORE INSERT ON audit_logs WHEN NEW.action='production.retention.run' BEGIN SELECT RAISE(ABORT,'injected retention'); END");
 await expect(f.p.applyRetention(new Date(Date.now()+2*86400000))).rejects.toThrow(/injected/);expect((await f.p.loadRecords({projectId:f.projectId,window:{from:null,to:null},maxRecords:10})).records).toHaveLength(3);
 f.db.exec('DROP TRIGGER reject_production_retention');expect((await f.p.applyRetention(new Date(Date.now()+2*86400000))).projects[0]?.deleted).toEqual({decisions:1,actions:0,outcomes:2});
 expect(await f.p.getSnapshot(f.projectId,saved.id)).toEqual({snapshot:saved,artifact});
 await f.runtime.close();const restarted=await createSqliteRuntime(f.path);cleanup.push(()=>restarted.close());expect(await restarted.productionRecords.getSnapshot(f.projectId,saved.id)).toEqual({snapshot:saved,artifact});
 expect(await restarted.productionRecords.getSnapshot('other',saved.id)).toBeNull();expect(await restarted.productionRecords.deleteSnapshot({projectId:f.projectId,userId:f.user.id,snapshotId:saved.id})).toBe(true);expect(await restarted.productionRecords.listSnapshots(f.projectId)).toEqual([]);
 expect(()=>f.db.exec('DELETE FROM production_calibration_snapshots')).not.toThrow();
});
it('preserves erasure tombstones and fences revoked-key appends and purges in audited transactions',async()=>{
 const f=await fixture(),actor={projectId:f.projectId,userId:f.user.id},key=await f.r.createApiKey({projectId:f.projectId,name:'ingest',capability:'production_ingest',createdByUserId:f.user.id});
 const input={projectId:f.projectId,submitter:{kind:'api_key' as const,apiKeyId:key.id}};
 await f.p.appendRecords({...input,records:[decision('erase'),outcome('erase'),decision('purge')]});
 f.db.exec("CREATE TRIGGER reject_production_erase BEFORE INSERT ON audit_logs WHEN NEW.action='production.decision.erase' BEGIN SELECT RAISE(ABORT,'injected erase'); END");
 await expect(f.p.eraseDecision({...actor,decisionId:'erase'})).rejects.toThrow(/injected/);expect(f.db.prepare('SELECT count(*) n FROM production_decision_tombstones').get()?.n).toBe(0);
 f.db.exec('DROP TRIGGER reject_production_erase');expect(await f.p.eraseDecision({...actor,decisionId:'erase'})).toEqual({decisions:1,actions:0,outcomes:1});
 await expect(f.p.appendRecords({...input,records:[outcome('erase')]})).rejects.toMatchObject({code:'erased_decision'});
 expect(()=>f.db.exec('DELETE FROM production_decision_tombstones')).toThrow(/erasure/);
 await expect(f.p.purgeApiKeyRecords({...actor,apiKeyId:key.id})).rejects.toMatchObject({code:'api_key_not_revoked'});
 await f.r.revokeApiKey(f.projectId,key.id);await expect(f.p.appendRecords({...input,records:[decision('late')]})).rejects.toMatchObject({code:'api_key_revoked'});
 expect(await f.p.purgeApiKeyRecords({...actor,apiKeyId:key.id})).toEqual({decisions:1,actions:0,outcomes:0});
 const log=f.db.prepare("SELECT target_id,metadata FROM audit_logs WHERE action='production.decision.erase'").get()!;expect(log.target_id).toMatch(/^sha256:/);expect(String(log.metadata)).not.toContain('"erase"');
 await f.r.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT count(*) n FROM production_decision_tombstones').get()?.n).toBe(0);expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('orders microsecond outcomes independently of reverse arrival and timezone notation',async()=>{
 const f=await fixture(),input={projectId:f.projectId,submitter:{kind:'user' as const,userId:f.user.id}};
 await f.p.appendRecords({...input,records:[decision('precise')]});
 await f.p.appendRecords({...input,records:[outcome('precise','2026-09-20T11:00:00.000200Z')]});
 await f.p.appendRecords({...input,records:[{...outcome('precise','2026-09-20T13:00:00.000100+02:00'),value:false}]});
 const loaded=await f.p.loadRecords({projectId:f.projectId,window:{from:new Date('2026-09-20'),to:new Date('2026-09-21')},maxRecords:10});
 expect(loaded.records.filter(r=>r.kind==='outcome').map(r=>r.value)).toEqual([false,true]);
 expect(joinProductionDecisionRecords(loaded.records)[0]?.outcomes.is_flaky?.value).toBe(true);
 expect(f.db.prepare("SELECT record_at FROM production_decision_records WHERE kind='outcome' ORDER BY record_at").all().map(r=>r.record_at)).toEqual(['2026-09-20T11:00:00.000100Z','2026-09-20T11:00:00.000200Z']);
});
it('accepts the shared minute-precision and offset timestamp contract and types invalid repository times',async()=>{
 const f=await fixture(),input={projectId:f.projectId,submitter:{kind:'user' as const,userId:f.user.id}};
 expect(await f.p.appendRecords({...input,records:[decision('minute',0.8,'2026-09-20T10:00Z'),outcome('minute','2026-09-20T13:00+02:00')]})).toMatchObject({inserted:{decisions:1,outcomes:1}});
 expect(f.db.prepare('SELECT record_at FROM production_decision_records ORDER BY record_at').all().map(r=>r.record_at)).toEqual(['2026-09-20T10:00:00.000000Z','2026-09-20T11:00:00.000000Z']);
 const loaded=await f.p.loadRecords({projectId:f.projectId,window:{from:new Date('2026-09-20T10:00Z'),to:new Date('2026-09-20T12:00+01:00')},maxRecords:10});
 expect(loaded.records.map(r=>r.at)).toEqual(['2026-09-20T10:00Z','2026-09-20T13:00+02:00']);
 // Bypass the HTTP schema: the repository still answers with typed errors.
 for(const at of ['2026-09-20T10:00+0200','2026-02-30T10:00Z','2026-09-20T10:00:00.Z'])
  await expect(f.p.appendRecords({...input,records:[decision('valid'),decision('bad',0.8,at)]})).rejects.toMatchObject({name:'ProductionRecordRepositoryError',code:'invalid_record',details:{line:2}});
 await expect(f.p.loadRecords({projectId:f.projectId,window:{from:new Date('invalid'),to:null},maxRecords:10})).rejects.toMatchObject({name:'ProductionRecordRepositoryError',code:'invalid_window',details:{bound:'from'}});
 const artifact=buildProductionCalibrationArtifact(loaded.records,{now:new Date('2026-09-21T00:00Z'),window:{from:new Date('2026-09-20T10:00Z'),to:new Date('2026-09-20T11:00Z')}});
 const minuteArtifact={...artifact,window:{from:'2026-09-20T10:00Z',to:'2026-09-20T13:00+02:00'}},snapshot={projectId:f.projectId,userId:f.user.id,parameters:{},recordCount:2,recordSetDigest:loaded.recordSetDigest};
 const saved=await f.p.saveSnapshot({...snapshot,artifact:minuteArtifact});
 expect(saved.window).toEqual({from:'2026-09-20T10:00:00.000Z',to:'2026-09-20T11:00:00.000Z'});expect(await f.p.getSnapshot(f.projectId,saved.id)).toEqual({snapshot:saved,artifact:minuteArtifact});
 await expect(f.p.saveSnapshot({...snapshot,artifact:{...artifact,window:{from:artifact.window.from,to:'2026-09-20T11:00+0100'}}})).rejects.toMatchObject({name:'ProductionRecordRepositoryError',code:'invalid_window',details:{bound:'to'}});
 expect(await f.p.listSnapshots(f.projectId)).toHaveLength(1);
});
