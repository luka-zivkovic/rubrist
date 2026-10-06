import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '@rubrist/db';
import { CreateCriterionInputSchema, MinimumVerdictOutputSchema, type DatasetRevisionItem } from '@rubrist/shared';
import { createUnseededSqliteRuntime as createSqliteRuntime } from './helpers/sqlite.js';
import { openPostgresTestDatabase } from './helpers/postgres.js';
import { MOCK_BINDING, bindingInput } from './fixtures/execution-binding.js';
import { datasetRevisionItemDigest } from '../src/lib/dataset-revision.js';
import { canonicalJson } from '../src/lib/canonical-json.js';
import { PgRepository } from '../src/repository.pg.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedDraftFixture } from './helpers/sqlite-governed-draft.js';
// M3 parity: repository-level imports (integration workers) keep source steps
// raw. PostgreSQL freezes that exact source projection, so SQLite must too.
const cases=[
 ['untrimmed step name',[{name:' step ',input:'a',output:'b'}]],
 ['extra step key',[{name:'step',input:'a',output:'b',kind:'llm'}]],
 ['whitespace-only step name',[{name:'   ',input:'a',output:'b'}]]
] as const;
const cleanup:Array<()=>unknown>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
const projection=(steps:unknown)=>({input:'q',output:'a',metadata:{},steps});
function expectPgDigest(item:DatasetRevisionItem,steps:unknown) {
 expect(item.payloadSnapshot).toEqual(projection(steps));
 expect(item.itemDigest).toBe(datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:item.inputDigest},redactedPayload:projection(steps),referenceLabel:item.referenceLabel,expectedFailStep:item.referenceFailStep,reviewProvenance:item.referenceProvenance,note:item.note}));
}
async function sqliteFreeze(steps:unknown) {
 vi.stubEnv('BETTER_AUTH_SECRET','sqlite-parity-test-secret-at-least-32-characters');
 const dir=mkdtempSync(join(tmpdir(),'rubrist-parity-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const runtime=await createSqliteRuntime(join(dir,'db.sqlite'));cleanup.push(()=>runtime.close());
 const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
 const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
 const r=runtime.repository,dataset=await r.createDataset({projectId,name:'Examples'});
 const imported=await r.importTrace(projectId,'manual',{sourceTraceId:'t1',input:'q',output:'a',metadata:{},steps} as never,{ingestionPurpose:'judge_api'});
 await r.addDatasetItems({projectId,datasetId:dataset.id,items:[{caseId:imported.caseId}]});
 const revision=await r.createDatasetRevision({projectId,datasetId:dataset.id,role:'iterative_development'});
 const created=await r.createCriterion(projectId,CreateCriterionInputSchema.parse({stableKey:'grounded',name:'Grounded',definition:'Use evidence.',evaluator:{rubricMarkdown:'Pass grounded answers.',prompt:'Judge {{rubric_markdown}}.',executionBinding:bindingInput(MOCK_BINDING)}}),{});
 const versionId=created.evaluator.currentVersion.id,criterionVersionId=created.versions[0]!.id;
 await r.recordJudgeRun({projectId,caseId:imported.caseId,skillVersionId:versionId,verdict:{label:'fail',score:0.1,confidence:0.9,reason:'Synthetic failure'}});
 await r.promoteExceptionToGoldenSet({projectId,caseId:imported.caseId,skillVersionId:versionId,agreedLabel:'pass',reason:'Human reviewed',actorUserId:user.id,actorName:'Owner'});
 const regression=await r.getOrCreateRegressionDatasetRevision(projectId,user.id,criterionVersionId);
 return {r,projectId,revision,regression};
}
describe('SQLite ordinary dataset freezes retain the exact PostgreSQL source projection',()=>{
 it.each(cases)('freezes and promotes a case with %s',async(_label,steps)=>{
  const {r,projectId,revision,regression}=await sqliteFreeze(steps);
  expectPgDigest(revision.items[0]!,steps);
  expect(regression).toMatchObject({role:'regression_golden',itemCount:1});
  expectPgDigest(regression.items[0]!,steps);
  expect(await r.getDatasetRevisionDetail(projectId,revision.id)).toEqual(revision);
 });
 it('keeps metadata-free governed payloads strictly schema-canonical',async()=>{
  const f=await governedDraftFixture(),source=f.db.prepare('SELECT * FROM dataset_revisions WHERE id=?').get(f.revision.id)!;
  for(const steps of [[{name:'   ',input:'Q',output:'A'}],[{name:'step',input:'Q',output:'A',hidden:'x'}]]) {
   const payload={input:'Q',output:'A',steps},provenance={kind:'unlabeled',sourceId:'synthetic',verdictIds:[],actorUserIds:[],basis:'No truth'};
   const digest=datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:'sha256:'+'a'.repeat(64)},redactedPayload:payload,referenceLabel:null,expectedFailStep:null,reviewProvenance:provenance,note:null});
   expect(()=>sqliteCommand(f.db,c=>{
    const revision={...source,id:'attempt',series_id:'attempt',source_dataset_id:null,criterion_version_id:f.criterionVersionId,provenance_level:'governed_blind',item_count:1,idempotency_key:'attempt',created_at:c.timestamp};
    c.db.prepare(`INSERT INTO dataset_revisions(${Object.keys(revision).join(',')}) VALUES(${Object.keys(revision).map(()=>'?').join(',')})`).run(...Object.values(revision));
    c.db.prepare('INSERT INTO dataset_revision_items(id,revision_id,project_id,position,input_digest,item_digest,payload_snapshot,reference_provenance,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('attempt-item','attempt',f.projectId,0,'sha256:'+'a'.repeat(64),digest,JSON.stringify(payload),JSON.stringify(provenance),c.timestamp);
   })).toThrow(/dataset item digest mismatch/);
  }
 });
});

const databaseUrl=process.env.PG_SMOKE_DATABASE_URL;
(databaseUrl?describe:describe.skip)('PostgreSQL source projection parity',()=>{
 it.each(cases)('PostgreSQL and SQLite freeze identical payloads and digest inputs for %s',async(_label,steps)=>{
  const {pool,cleanup:drop}=await openPostgresTestDatabase('dataset_source_parity');cleanup.push(drop);
  await runMigrations(pool);
  const repository=new PgRepository(pool);
  await pool.query(`insert into organizations (id, name) values ('org_test', 'Test Org')`);
  await pool.query(`insert into projects (id, organization_id, name, trace_provider) values ('proj_test', 'org_test', 'Test Project', 'manual')`);
  await pool.query(`insert into criteria (id,project_id,stable_key,source_kind) values ('criterion_test','proj_test','correctness','native')`);
  await pool.query(`insert into criterion_versions (id,project_id,criterion_id,revision,name,definition,criterion_digest,source_kind) values ('criterionv_test','proj_test','criterion_test',1,'Correctness','The answer is correct.',criterion_v1_digest('criterion_test','criterionv_test','Correctness','The answer is correct.'),'native')`);
  await pool.query(`insert into skills (id, project_id, name, description, owner_user_id, status, criterion_id) values ('skill_test', 'proj_test', 'Judge', 'fixture', null, 'production', 'criterion_test')`);
  await pool.query(`insert into skill_versions (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, execution_binding, golden_set_agreement, too_strict_count, too_lenient_count, ambiguous_count, known_limitations, verdict_kind, scalar_range, categorical_choice_scores, rubric_provenance, criterion_version_id, created_at, approved_at) values ('skillv_base','skill_test','proj_test','1.0.0','approved','# Rubric','Judge.', $1, $2, null,0,0,0,'{}','binary',null,null,'human-authored','criterionv_test',now(),now())`,[JSON.stringify(MinimumVerdictOutputSchema),JSON.stringify(MOCK_BINDING)]);
  const dataset=await repository.createDataset({projectId:'proj_test',name:'Examples'});
  const imported=await repository.importTrace('proj_test','manual',{sourceTraceId:'t1',input:'q',output:'a',metadata:{},steps} as never,{ingestionPurpose:'judge_api'});
  await repository.addDatasetItems({projectId:'proj_test',datasetId:dataset.id,items:[{caseId:imported.caseId}]});
  const pg=await repository.createDatasetRevision({projectId:'proj_test',datasetId:dataset.id,role:'iterative_development'});
  await pool.query(`insert into golden_set_entries (id, project_id, case_id, trace_id, agreed_label, reason, promoted_by, source_skill_version_id, criterion_version_id) values ('gold_test','proj_test',$1,'t1','pass','Human reviewed','Reviewer','skillv_base','criterionv_test')`,[imported.caseId]);
  const pgRegression=await repository.getOrCreateRegressionDatasetRevision('proj_test',undefined,'criterionv_test');
  const sqlite=await sqliteFreeze(steps);
  for(const [left,right] of [[pg.items[0]!,sqlite.revision.items[0]!],[pgRegression.items[0]!,sqlite.regression.items[0]!]] as const) {
   expectPgDigest(left,steps);expectPgDigest(right,steps);
   expect(canonicalJson(right.payloadSnapshot)).toBe(canonicalJson(left.payloadSnapshot));
   expect(right.inputDigest).toBe(left.inputDigest);
  }
 });
});
