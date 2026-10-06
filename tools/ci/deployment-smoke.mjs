#!/usr/bin/env node
// Disposable localhost installation only. Never reads operator credentials.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const [mode,base,statePath]=process.argv.slice(2);
const url=new URL(base);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Smoke requires a disposable localhost installation');
assert.ok(['create','verify'].includes(mode)&&statePath,'Usage: deployment-smoke.mjs create|verify BASE_URL STATE_FILE');
async function request(path,options={},expected=200){const response=await fetch(new URL(path,base),{...options,signal:AbortSignal.timeout(10_000)});assert.equal(response.status,expected,`${path}: ${await response.clone().text()}`);return response;}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let state;
if(mode==='create'){
 const email=`smoke-${randomUUID()}@example.test`,password='synthetic-smoke-password-never-use-in-deployment';
 const setup=await request('/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password,name:'Synthetic smoke owner'})});
 const cookie=setup.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 const headers={cookie,'content-type':'application/json'};
 const key=await (await request('/api/api-keys',{method:'POST',headers,body:JSON.stringify({name:'Disposable smoke harness'})},201)).json();
 const apiKey=key.key??key.apiKey?.key;assert.ok(apiKey);
 const binding={provider:'mock',endpoint:{kind:'managed'},modelId:'mock-heuristic-v1',modelVersion:'mock-heuristic-v1',sampling:{temperature:null,topP:null},reasoning:null,outputTokenLimit:null,verdictProtocol:'mock/v1',routing:null};
 const criterion=await (await request('/api/v1/criteria',{method:'POST',headers,body:JSON.stringify({stableKey:'smoke-grounded',name:'Synthetic grounded',definition:'Answers follow the supplied evidence.',evaluator:{rubricMarkdown:'Pass grounded answers.',prompt:'Judge: {{rubric_markdown}}',executionBinding:binding}})},201)).json();
 const versionId=criterion.evaluator.currentVersion.id;
 const authorization=`Bearer ${apiKey}`;
 const accepted=await (await request('/api/v1/judge/batch',{method:'POST',headers:{authorization,'content-type':'application/json'},body:JSON.stringify({purpose:'release_evidence',skillVersionId:versionId,items:[{clientItemId:'smoke-one',input:'Synthetic question',output:'Synthetic answer',metadata:{}}]})},202)).json();
 state={email,password,cookie,apiKey,runId:accepted.run?.id??accepted.evalRunId??accepted.runId};
 assert.ok(state.runId);
}else state=JSON.parse(readFileSync(statePath,'utf8'));
const headers={authorization:`Bearer ${state.apiKey}`};
let detail;
for(let attempt=0;attempt<120;attempt++){
 detail=await(await request(`/api/v1/eval-runs/${state.runId}`,{headers})).json();
 if(['completed','failed'].includes(detail.run?.status??detail.status))break;
 await new Promise(resolve=>setTimeout(resolve,250));
}
assert.equal(detail.run?.status??detail.status,'completed',JSON.stringify(detail));
const receiptPath=`/api/v1/eval-runs/${state.runId}/assessment-receipt`;
const receipt=Buffer.from(await(await request(receiptPath,{headers})).arrayBuffer());
if(mode==='create'){state.receiptSha256=sha(receipt);writeFileSync(statePath,JSON.stringify(state)+'\n',{flag:'wx',mode:0o600});}
else assert.equal(sha(receipt),state.receiptSha256,'Receipt bytes changed across restart/restore');
await request('/api/projects',{headers:{cookie:state.cookie}});
const login=await request('/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin:url.origin},body:JSON.stringify({email:state.email,password:state.password})});
assert.ok(login.headers.getSetCookie().length);
assert.equal((await fetch(new URL(receiptPath,base))).status,401);
console.log(`Disposable installation ${mode} passed: account, session, harness key, mock evaluation and exact receipt bytes.`);
