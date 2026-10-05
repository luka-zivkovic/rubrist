import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '@rubrist/db/sqlite';
import { createUnseededSqliteRuntime as createSqliteRuntime } from './helpers/sqlite.js';
import { datasetInputIdentity } from '../src/lib/dataset-revision.js';
import { RecursiveTraceSkippedError } from '../src/repository/errors.js';
import { REDACTED_VALUE, EXCLUDED_VALUE } from '../src/lib/redaction.js';
const cleanup: Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();vi.unstubAllEnvs();});
async function fixture() {
  vi.stubEnv('BETTER_AUTH_SECRET','sqlite-traces-test-secret-at-least-32-characters');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-traces-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'),runtime=await createSqliteRuntime(path);cleanup.push(()=>runtime.close());
  const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
  const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
  return {path,runtime,projectId};
}
describe('SQLite native trace ingestion',()=>{
  it('preserves origin under concurrent duplicate imports and persists input identity before redaction',async()=>{
    const f=await fixture(),r=f.runtime.repository;
    const peer=await createSqliteRuntime(f.path);cleanup.push(()=>peer.close());
    const input={metadata:{},sourceTraceId:'trace-1',input:{text:'hello 😀',password:'secret',context:{private:'remove'}},output:'answer',
      steps:[{name:'step',input:{token:'redact'},output:'step answer'}]};
    const context={ingestionPurpose:'judge_api' as const,redactionConfig:{excludedPaths:['input.context.private']}};
    const imports=await Promise.all(Array.from({length:8},(_,i)=>(i%2?r:peer.repository).importTrace(f.projectId,'manual',input,context)));
    expect(imports.filter(item=>item.created)).toHaveLength(1);
    expect(new Set(imports.map(item=>item.caseId)).size).toBe(1);
    const original=imports[0]!;
    await r.importTrace(f.projectId,'manual',{...input,output:'changed'},{ingestionPurpose:'analysis_eligible_manual'});
    const listed=await r.listCases(f.projectId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.trace).toMatchObject({input:{password:REDACTED_VALUE,context:{private:EXCLUDED_VALUE}},output:'answer',steps:[{input:{token:REDACTED_VALUE}}]});
    const db=openSqlite(f.path);cleanup.push(()=>db.close());
    expect(db.prepare('SELECT ingestion_purpose FROM cases').get()?.ingestion_purpose).toBe('judge_api');
    expect(db.prepare('SELECT input_digest FROM case_input_identity_records').get()?.input_digest).toBe(datasetInputIdentity({input:input.input}).digest);
    expect(db.prepare('SELECT imported_trace_count FROM projects WHERE id=?').get(f.projectId)?.imported_trace_count).toBe(1);
    await f.runtime.close(); const restarted=await createSqliteRuntime(f.path);cleanup.push(()=>restarted.close());
    expect(await restarted.repository.getCaseSourceIdentity(f.projectId,original.caseId)).toEqual({source:'manual',sourceTraceId:'trace-1',sourceTraceVersion:null,sourceRemoteProjectId:null,sourceIntegrationId:null});
    expect(await restarted.repository.listCases(f.projectId)).toEqual(listed);
    expect(await restarted.repository.caseExistsForProject('other',original.caseId)).toBe(false);
  });
  it('separates source versions/remote projects and excludes receipt scaffolding from traffic counts and reads',async()=>{
    const f=await fixture(),r=f.runtime.repository,input={metadata:{},sourceTraceId:'same',input:'x',output:'y'};
    for(const context of [{},{sourceTraceVersion:'v1'},{sourceTraceVersion:'v2'},{sourceRemoteProjectId:'remote'}]) {
      expect((await r.importTrace(f.projectId,'manual',input,{ingestionPurpose:'judge_batch_general',...context})).created).toBe(true);
    }
    const release=await r.importTrace(f.projectId,'release_evidence',input,{ingestionPurpose:'release_evidence'});
    expect(await r.listCaseIdsForProject(f.projectId)).toHaveLength(4);
    expect((await r.listCaseIdsForProject(f.projectId)).includes(release.caseId)).toBe(false);
    expect(await r.listCases(f.projectId,{limit:2})).toHaveLength(2);
    expect(await r.listCases(f.projectId,{limit:0})).toEqual([]);
    for(const limit of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]) {
      await expect(r.listCases(f.projectId,{limit})).rejects.toThrow(/limit/);
      await expect(r.listCaseIdsForProject(f.projectId,limit)).rejects.toThrow(/limit/);
    }
    expect(await r.listCases(f.projectId,{since:'2099-01-01T00:00:00Z'})).toEqual([]);
    const db=openSqlite(f.path);cleanup.push(()=>db.close());
    expect(db.prepare('SELECT imported_trace_count FROM projects WHERE id=?').get(f.projectId)?.imported_trace_count).toBe(4);
  });
  it('rejects recursion, invalid purpose and failed constraints atomically, with no counter movement',async()=>{
    const f=await fixture(),r=f.runtime.repository,input={input:'x',output:'y',metadata:{}};
    await expect(r.importTrace(f.projectId,'manual',{...input,metadata:{rubrist:{internal:true}}},{ingestionPurpose:'judge_api'})).rejects.toBeInstanceOf(RecursiveTraceSkippedError);
    await expect(r.importTrace(f.projectId,'manual',input,{ingestionPurpose:'release_evidence'})).rejects.toThrow(/not valid/);
    await expect(r.importTrace(f.projectId,'manual',input,{ingestionPurpose:'judge_api',sourceTraceVersion:''})).rejects.toThrow(/CHECK/);
    await expect(r.importTrace('other','manual',input,{ingestionPurpose:'judge_api'})).rejects.toThrow(/FOREIGN KEY/);
    const db=openSqlite(f.path);cleanup.push(()=>db.close());
    expect(db.prepare('SELECT count(*) n FROM raw_traces').get()?.n).toBe(0);
    expect(db.prepare('SELECT imported_trace_count FROM projects WHERE id=?').get(f.projectId)?.imported_trace_count).toBe(0);
    const imported=await r.importTrace(f.projectId,'manual',input,{ingestionPurpose:'judge_api'});
    expect(()=>db.exec("UPDATE cases SET ingestion_purpose='analysis_eligible_manual'")).toThrow(/immutable/);
    expect(()=>db.exec('DELETE FROM case_input_identity_records')).toThrow(/erasure/);
    db.prepare('DELETE FROM cases WHERE id=?').run(imported.caseId);
    db.prepare('DELETE FROM raw_traces WHERE id=?').run(imported.rawTraceId);
    expect(db.prepare('SELECT count(*) n FROM case_input_identity_records').get()?.n).toBe(1);
    await r.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
    expect(db.prepare('SELECT count(*) n FROM case_input_identity_records').get()?.n).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe('SQLite dataset collections',()=>{
  it('retains label upserts, clears a failure step on pass, and persists membership on restart',async()=>{
    const f=await fixture(),r=f.runtime.repository;
    const imported=await r.importTrace(f.projectId,'manual',{input:'x',output:'y',metadata:{}},{ingestionPurpose:'dataset_example'});
    const dataset=await r.createDataset({projectId:f.projectId,name:' Cases '});
    expect(dataset.name).toBe('Cases');
    const first=await r.addDatasetItems({projectId:f.projectId,datasetId:dataset.id,items:[{caseId:imported.caseId,expectedLabel:'fail',expectedFailStep:0,note:'Check first step'}]});
    const append=await r.addDatasetItems({projectId:f.projectId,datasetId:dataset.id,items:[{caseId:imported.caseId}]});
    expect(append).toEqual(first);
    const pass=await r.addDatasetItems({projectId:f.projectId,datasetId:dataset.id,items:[{caseId:imported.caseId,expectedLabel:'pass'}]});
    expect(pass[0]).toMatchObject({id:first[0]!.id,expectedLabel:'pass',expectedFailStep:null,note:'Check first step'});
    const partial=await r.addDatasetItems({projectId:f.projectId,datasetId:dataset.id,items:[{caseId:imported.caseId,expectedFailStep:2}]});
    expect(partial).toEqual(pass);
    expect((await r.listDatasets(f.projectId))[0]?.itemCount).toBe(1);
    await f.runtime.close();const restarted=await createSqliteRuntime(f.path);cleanup.push(()=>restarted.close());
    expect((await restarted.repository.getDatasetDetail(f.projectId,dataset.id))?.items).toEqual(pass);
    expect(await restarted.repository.getDatasetDetail('other',dataset.id)).toBeNull();
    expect(await restarted.repository.removeDatasetItem('other',dataset.id,pass[0]!.id)).toBe(false);
    expect(await restarted.repository.removeDatasetItem(f.projectId,dataset.id,pass[0]!.id)).toBe(true);
  });
  it('rolls back a mixed-validity add including updates to existing labels',async()=>{
    const f=await fixture(),r=f.runtime.repository;
    const imported=await r.importTrace(f.projectId,'manual',{input:'x',output:'y',metadata:{}},{ingestionPurpose:'dataset_example'});
    const dataset=await r.createDataset({projectId:f.projectId,name:'Rollback'});
    const original=await r.addDatasetItems({projectId:f.projectId,datasetId:dataset.id,items:[{caseId:imported.caseId,expectedLabel:'fail'}]});
    await expect(r.addDatasetItems({projectId:f.projectId,datasetId:dataset.id,items:[{caseId:imported.caseId,expectedLabel:'pass'},{caseId:'missing'}]})).rejects.toThrow(/not found/i);
    expect((await r.getDatasetDetail(f.projectId,dataset.id))?.items).toEqual(original);
  });
  it('enforces active-name uniqueness, archive boundaries and project erasure',async()=>{
    const f=await fixture(),r=f.runtime.repository;
    const dataset=await r.createDataset({projectId:f.projectId,name:'Collection'});
    await expect(r.createDataset({projectId:f.projectId,name:'Collection'})).rejects.toThrow(/already/i);
    expect(await r.archiveDataset('other',dataset.id)).toBe(false);
    expect(await r.archiveDataset(f.projectId,dataset.id)).toBe(true);
    expect(await r.archiveDataset(f.projectId,dataset.id)).toBe(false);
    await expect(r.addDatasetItems({projectId:f.projectId,datasetId:dataset.id,items:[]})).rejects.toThrow(/not found/i);
    expect(await r.listDatasets(f.projectId)).toEqual([]);
    const replacement=await r.createDataset({projectId:f.projectId,name:'Collection'});
    expect(replacement.id).not.toBe(dataset.id);
    const imported=await r.importTrace(f.projectId,'manual',{input:'x',output:'y',metadata:{}},{ingestionPurpose:'dataset_example'});
    await r.addDatasetItems({projectId:f.projectId,datasetId:replacement.id,items:[{caseId:imported.caseId}]});
    await r.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
    const db=openSqlite(f.path);cleanup.push(()=>db.close());
    expect(db.prepare('SELECT count(*) n FROM dataset_items').get()?.n).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
