import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '@rubrist/db/sqlite';
import { createSqliteRuntime } from '../src/storage/sqlite/runtime.js';
import { createApp } from '../src/app.js';
import { registerEvalRunWorkers, recoverStaleEvalRunItemExecutions } from '../src/workers/eval-run.js';
import { MockJudgeProvider } from '@rubrist/audit/runtime';
import { MOCK_BINDING, bindingInput } from './fixtures/execution-binding.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();vi.unstubAllEnvs();});
async function fixture() {
  vi.stubEnv('BETTER_AUTH_SECRET','sqlite-workflow-test-secret-at-least-32-characters');
  const dir=mkdtempSync(join(tmpdir(),'rubrist-workflow-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'),runtime=await createSqliteRuntime(path);cleanup.push(()=>runtime.close());
  const app=createApp(runtime.repository,{auth:runtime.auth,accounts:runtime.accounts,runtimeMode:'persistent',accountStage:true,queue:runtime.queue});
  const response=await app.request('/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@example.test',password:'synthetic-long-password',name:'Owner'})});
  expect(response.status).toBe(200);
  const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const projectResponse=await app.request('/api/projects',{headers:{cookie}});expect(projectResponse.status).toBe(200);
  const keyResponse=await app.request('/api/api-keys',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({name:'Synthetic evaluation'})});
  expect(keyResponse.status).toBe(201);
  const key=await keyResponse.json() as {key?:string;apiKey?:{key:string}};
  const headers={authorization:`Bearer ${key.key??key.apiKey?.key}`,'content-type':'application/json'};
  const definition=await app.request('/api/v1/criteria',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({stableKey:'grounded',name:'Grounded',definition:'Answers follow evidence.',evaluator:{rubricMarkdown:'Pass grounded answers.',prompt:'Judge: {{rubric_markdown}}',executionBinding:bindingInput(MOCK_BINDING)}})});
  expect(definition.status).toBe(201);
  const created=await definition.json() as {evaluator:{currentVersion:{id:string}}};
  return {path,runtime,app,headers,cookie,versionId:created.evaluator.currentVersion.id};
}
function observedProvider() {
  const provider=new MockJudgeProvider();
  const calls=vi.spyOn(provider,'judgeStructured').mockImplementation(async()=>({verdict:{kind:'binary',label:'pass',score:0.9,rationale:'Synthetic supported answer'},observed:{model:MOCK_BINDING.modelId,requestId:'synthetic-provider-request',responseId:null,systemFingerprint:null,upstreamProvider:null,thinkingReturned:null,reasoningTokens:null},usage:{inputTokens:5,outputTokens:3}}));
  return {provider,calls};
}
async function waitTerminal(app:ReturnType<typeof createApp>,headers:Record<string,string>,id:string) {
  let result:any;
  await vi.waitFor(async()=>{const response=await app.request(`/api/v1/eval-runs/${id}`,{headers});expect(response.status).toBe(200);result=await response.json();expect(['completed','failed']).toContain(result.run?.status??result.status);},{timeout:10_000,interval:50});
  return result;
}
describe('SQLite authenticated durable batch workflow',()=>{
  it('keeps regression-backed version history behind the authenticated M2 staging boundary',async()=> {
    const f=await fixture(),headers={cookie:f.cookie};
    const current=await (await f.app.request('/api/skills/current',{headers})).json() as any;
    const read=vi.spyOn(f.runtime.repository,'listSkillVersions');
    const response=await f.app.request(`/api/skills/${current.id}/versions`,{headers});
    expect(response.status).toBe(503);expect(await response.json()).toMatchObject({code:'sqlite_feature_unavailable'});
    expect(read).not.toHaveBeenCalled();read.mockRestore();
  });
  it('returns validation errors for blank collection names and refuses archival races before dispatch',async()=> {
    const f=await fixture(),headers={cookie:f.cookie,'content-type':'application/json'};
    const blank=await f.app.request('/api/datasets',{method:'POST',headers,body:JSON.stringify({name:' \t '})});
    expect(blank.status).toBe(400);
    const {projects}=await (await f.app.request('/api/projects',{headers})).json() as any,projectId=projects[0].id;
    const trace=await f.runtime.repository.importTrace(projectId,'manual',{input:'x',output:'y',metadata:{}},{ingestionPurpose:'dataset_example'});
    const dataset=await f.runtime.repository.createDataset({projectId,name:'Concurrent archive'});
    await f.runtime.repository.addDatasetItems({projectId,datasetId:dataset.id,items:[{caseId:trace.caseId}]});
    const create=f.runtime.repository.createEvalRun.bind(f.runtime.repository);
    const archive=vi.spyOn(f.runtime.repository,'createEvalRun').mockImplementationOnce(async input=>{
      await f.runtime.repository.archiveDataset(projectId,dataset.id);
      return create(input);
    });
    const send=vi.spyOn(f.runtime.queue,'send');
    const response=await f.app.request('/api/eval-runs',{method:'POST',headers,body:JSON.stringify({datasetId:dataset.id,skillVersionId:f.versionId})});
    expect(response.status).toBe(404);expect(await response.json()).toEqual({error:'Dataset not found'});
    expect(archive).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled();
    expect(await f.runtime.repository.listEvalRuns(projectId)).toEqual([]);
    archive.mockRestore();send.mockRestore();
  });
  it('signs up, authors a native evaluator, survives restart before delivery and serves exact receipt bytes',async()=> {
    const f=await fixture();
    expect((await f.app.request('/api/eval-runs?purpose=backfill',{headers:{cookie:f.cookie}})).status).toBe(200);
    const body={purpose:'release_evidence',skillVersionId:f.versionId,items:[{clientItemId:'case-one',input:'Question',output:'Grounded answer',metadata:{}}]};
    const accepted=await f.app.request('/api/v1/judge/batch',{method:'POST',headers:f.headers,body:JSON.stringify(body)});
    expect(accepted.status).toBe(202);const {evalRunId}=await accepted.json() as {evalRunId:string};
    await f.runtime.close();
    const next=await createSqliteRuntime(f.path);cleanup.push(()=>next.close());
    const {provider,calls}=observedProvider();await next.queue.start();const worker=await registerEvalRunWorkers(next.queue,next.repository,provider);cleanup.push(()=>worker.stop());
    const app=createApp(next.repository,{auth:next.auth,accounts:next.accounts,runtimeMode:'persistent',accountStage:true,queue:next.queue});
    await waitTerminal(app,f.headers,evalRunId);
    const url=`/api/v1/eval-runs/${evalRunId}/assessment-receipt`,response=await app.request(url,{headers:f.headers});
    expect(response.status).toBe(200);const bytes=await response.text();expect(JSON.parse(bytes).items[0].result.state).toBe('outcome');expect(calls).toHaveBeenCalledTimes(1);
    const replay=await app.request('/api/v1/judge/batch',{method:'POST',headers:f.headers,body:JSON.stringify(body)});expect(replay.status).toBe(202);expect((await replay.json() as any).cachedItems).toBe(1);expect(calls).toHaveBeenCalledTimes(1);
    expect((await app.request(url,{headers:f.headers})).status).toBe(200);
    expect(await (await app.request(url,{headers:f.headers})).text()).toBe(bytes);
    expect((await app.request(url)).status).toBe(401);
  });
  it('submits a labeled collection through the session route and durably executes its snapshotted items',async()=> {
    const f=await fixture(),headers={cookie:f.cookie,'content-type':'application/json'};
    const projects=await f.app.request('/api/projects',{headers});
    const {projects:rows}=await projects.json() as any,projectId=rows[0].id;
    const cases=await Promise.all(['first','second'].map(input=>f.runtime.repository.importTrace(projectId,'manual',{input,output:'answer',metadata:{}},{ingestionPurpose:'dataset_example'})));
    const created=await f.app.request('/api/datasets',{method:'POST',headers,body:JSON.stringify({name:'Labeled collection'})});
    expect(created.status).toBe(201);const {dataset}=await created.json() as any;
    const added=await f.app.request(`/api/datasets/${dataset.id}/items`,{method:'POST',headers,body:JSON.stringify({items:[{caseId:cases[0]!.caseId,expectedLabel:'pass'},{caseId:cases[1]!.caseId,expectedLabel:'fail'}]})});
    expect(added.status).toBe(201);const {items}=await added.json() as any;
    const accepted=await f.app.request('/api/eval-runs',{method:'POST',headers,body:JSON.stringify({datasetId:dataset.id,skillVersionId:f.versionId})});
    expect(accepted.status).toBe(202);const {run}=await accepted.json() as any;
    // Mutating the collection after submission must not change the run's labels.
    const changed=await f.app.request(`/api/datasets/${dataset.id}/items`,{method:'POST',headers,body:JSON.stringify({items:[{caseId:cases[1]!.caseId,expectedLabel:'pass'}]})});
    expect(changed.status).toBe(201);
    expect((await changed.json() as any).items.find((item:any)=>item.caseId===cases[1]!.caseId).expectedLabel).toBe('pass');
    const {provider,calls}=observedProvider();await f.runtime.queue.start();
    const worker=await registerEvalRunWorkers(f.runtime.queue,f.runtime.repository,provider);cleanup.push(()=>worker.stop());
    await waitTerminal(f.app,f.headers,run.id);
    const response=await f.app.request(`/api/eval-runs/${run.id}`,{headers});expect(response.status).toBe(200);
    const detail=await response.json() as any;
    expect(detail).toMatchObject({id:run.id,datasetId:dataset.id,status:'completed',totalItems:2,completedItems:2,failedItems:0,agreedItems:1});
    expect(detail.items).toEqual(expect.arrayContaining([
      expect.objectContaining({caseId:cases[0]!.caseId,datasetItemId:items.find((item:any)=>item.caseId===cases[0]!.caseId).id,expectedLabel:'pass',resultLabel:'pass',agreement:true,status:'completed'}),
      expect.objectContaining({caseId:cases[1]!.caseId,datasetItemId:items.find((item:any)=>item.caseId===cases[1]!.caseId).id,expectedLabel:'fail',resultLabel:'pass',agreement:false,status:'completed'})
    ]));
    expect(detail.items).toHaveLength(2);expect(calls).toHaveBeenCalledTimes(2);
  });
  it('recovers committed run creation before queue send without calling the evaluator twice',async()=> {
    const f=await fixture(),r=f.runtime.repository;
    const projects=await f.app.request('/api/projects',{headers:{cookie:f.cookie}}),{projects:rows}=await projects.json() as any;
    const projectId=rows[0].id;
    const trace=await r.importTrace(projectId,'manual',{input:'x',output:'y',metadata:{}},{ingestionPurpose:'judge_batch_general'});
    const run=await r.createEvalRun({projectId,skillVersionId:f.versionId,trigger:'api_batch',items:[{caseId:trace.caseId}]});
    const db=openSqlite(f.path);cleanup.push(()=>db.close());db.prepare('UPDATE eval_run_items SET delivery_deadline_at=0 WHERE eval_run_id=?').run(run.id);
    const {provider,calls}=observedProvider();await f.runtime.queue.start();const worker=await registerEvalRunWorkers(f.runtime.queue,r,provider);cleanup.push(()=>worker.stop());
    await recoverStaleEvalRunItemExecutions(r,f.runtime.queue);await waitTerminal(f.app,f.headers,run.id);expect(calls).toHaveBeenCalledTimes(1);
  });
});
