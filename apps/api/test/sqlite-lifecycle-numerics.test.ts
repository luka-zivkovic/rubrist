import {expect,it} from 'vitest';
import {EvaluatorCandidateCreateInputSchema,type ExecutionBinding} from '@rubrist/shared';
import {runMigrations} from '@rubrist/db';
import {openPostgresTestDatabase} from './helpers/postgres.js';
import {runPgSmoke} from './pg-smoke-support.js';
import {lifecycleFixture} from './helpers/sqlite-lifecycle.js';
import {bindingInput,resolvedRecordFor} from './fixtures/execution-binding.js';
import {sha256Digest} from '../src/lib/canonical-json.js';
import {createLifecycleCandidate} from '../src/storage/sqlite/lifecycle-candidate.js';
import {evaluatorCandidateRequestDigest} from '../src/lib/evaluator-lifecycle.js';
import {canonicalGovernedJsonV1} from '../src/lib/governed-content-digest.js';
const binding:ExecutionBinding={provider:'typesafe',endpoint:{kind:'managed'},modelId:'jev-1.13.0',modelVersion:'jev-1.13.0',sampling:{temperature:null,topP:null},reasoning:null,outputTokenLimit:null,verdictProtocol:'typed-question/v1',routing:null};
const thresholds=[0.1,0.30000000000000004,0.9999999999999999,1e-7,5e-324];
it('retains exact binary64 thresholds and declared authorship in candidate request digests',async()=>{
 const f=await lifecycleFixture(),record=await resolvedRecordFor(binding);
 for(const [index,threshold] of thresholds.entries()){
  const {rubricMarkdown:_rubric,prompt:_prompt,outputSchema:_schema,...base}=f.candidateInput;
  const input=EvaluatorCandidateCreateInputSchema.parse({...base,typedQuestion:{type:'noul',instructions:'Is the response supported?',criteria:{true:'Supported',false:'Unsupported'}},decisionThreshold:threshold,executionBinding:bindingInput(binding),rubricProvenance:'human-authored',idempotencyKey:`typed-${index}`});
  const r=createLifecycleCandidate(f.db,f.actor,input,{bindingDigest:sha256Digest(binding),record});
  expect(r.skill.currentVersion.decisionThreshold).toBe(threshold);expect(r.projection.lifecycle.requestDigest).toBe(evaluatorCandidateRequestDigest(f.projectId,input));
 }
});
runPgSmoke('SQLite lifecycle numeric PostgreSQL oracle',()=>{
 it('matches exact numeric semantics and shortest threshold digests across engines',async()=>{
  const {pool,cleanup}=await openPostgresTestDatabase('sqlite_lifecycle_numbers');
  try{
   await runMigrations(pool);await pool.query('SET extra_float_digits=1');const f=await lifecycleFixture();
   for(const text of ['{"n":1.10}','{"n":1e21}','{"n":9007199254740993}','{"n":0.10000000000000001}','{"n":5e-324}']){
    const rounded=JSON.stringify(JSON.parse(text)),pg=(await pool.query('SELECT $1::jsonb=$2::jsonb equal',[text,rounded])).rows[0].equal;
    expect(Boolean(f.db.prepare('SELECT sqlite_lifecycle_payload_roundtrip(?) equal').get(text)?.equal)).toBe(pg);
   }
   for(const threshold of [...thresholds,null]){
    const pg=(await pool.query("SELECT governed_content_v1_digest('evaluator-candidate-request/v1',jsonb_build_object('decisionThreshold',$1::float8)) digest",[threshold])).rows[0].digest;
    const {governedContentV1Digest}=await import('../src/lib/governed-content-digest.js');
    expect(pg).toBe(governedContentV1Digest('evaluator-candidate-request/v1',{decisionThreshold:threshold}));
   }
   for(const number of [1e21,5e-324,1e-7])expect(f.db.prepare('SELECT governed_canonical_json_v1(?) canonical').get(JSON.stringify({number}))?.canonical).toBe(canonicalGovernedJsonV1({number}));
  }finally{await cleanup();}
 });
});
