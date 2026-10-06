import {sqliteRegressionCommands} from '../src/storage/sqlite/regression-commands.js';
import {expect,it} from 'vitest';
import {lifecycleFixture} from './helpers/sqlite-lifecycle.js';
import {createLifecycleCandidate} from '../src/storage/sqlite/lifecycle-candidate.js';
import {sqliteDefinitionCommands} from '../src/storage/sqlite/definition-commands.js';
import {loadLifecycleProjection,listLifecycleProjections} from '../src/storage/sqlite/lifecycle-reads.js';
it('creates an exact governed candidate bundle, replays and keeps implicit consumers closed',async()=>{
 const f=await lifecycleFixture(),result=createLifecycleCandidate(f.db,f.actor,f.candidateInput,f.resolution);
 expect(result.replayed).toBe(false);expect(result.projection.currentEvent.state).toBe('candidate');expect(result.skill.currentVersion.status).toBe('calibrating');
 expect(createLifecycleCandidate(f.db,f.actor,f.candidateInput)).toEqual({...result,replayed:true});
 const l=result.projection.lifecycle;
 expect(f.db.prepare('SELECT payload_snapshot FROM dataset_revision_items WHERE revision_id=? ORDER BY position').all(l.regressionDatasetRevisionId)).toEqual(f.db.prepare('SELECT payload_snapshot FROM dataset_revision_items WHERE revision_id=? ORDER BY position').all(f.truthId));
 expect(f.db.prepare('SELECT * FROM dataset_exposure_events WHERE revision_id=?').all(l.regressionDatasetRevisionId)).toEqual([]);
 expect(loadLifecycleProjection(f.db,f.projectId,l.skillVersionId)).toEqual(result.projection);
 expect(listLifecycleProjections(f.db,f.projectId,{limit:10,cursor:null})).toEqual({items:[result.projection],nextCursor:null,totalCount:'1'});
 const definitions=sqliteDefinitionCommands(f.db);
 expect(()=>definitions.getCurrentSkillForCriterion(f.projectId,l.criterionId)).toThrow();
 for(const context of ['implicit_production','manual_import','scheduled_import','suite_publication','trace_test','release_gate'] as const)expect(()=>definitions.authorizeSkillVersionExecution({projectId:f.projectId,skillVersionId:l.skillVersionId,context,resourceKind:'test',resourceId:'test',idempotencyKey:context})).toThrow(/not authorized/);
 for(const context of ['explicit_nonproduction_dataset','governed_nonsealed_evaluation','binary_calibration_evidence','candidate_regression_evidence'] as const)definitions.authorizeSkillVersionExecution({projectId:f.projectId,skillVersionId:l.skillVersionId,context,resourceKind:'test',resourceId:'test',idempotencyKey:context});
 expect(f.db.prepare('SELECT DISTINCT lifecycle_event_id FROM evaluator_execution_authorizations WHERE skill_version_id=?').all(l.skillVersionId)).toEqual([{lifecycle_event_id:result.projection.currentEvent.id}]);
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM evaluator_candidate_claims').all()).toEqual([]);
});
import {vi} from 'vitest';
import type {SQLInputValue} from 'node:sqlite';
import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
import {sqliteSuiteCommands} from '../src/storage/sqlite/suite-commands.js';
import {EvaluatorLifecycleRepositoryError} from '../src/evaluator-lifecycle/repository.js';
import {createUnseededSqliteRuntime} from './helpers/sqlite.js';
function alterInsert(db:import('node:sqlite').DatabaseSync,table:string,mutate:(row:Record<string,SQLInputValue>)=>Record<string,SQLInputValue>|null){
 const prepare=db.prepare.bind(db);
 return vi.spyOn(db,'prepare').mockImplementation(sql=>{
  const statement=prepare(sql),match=new RegExp(`^INSERT INTO ${table}\\(([^)]+)\\)`).exec(sql);if(!match)return statement;
  return new Proxy(statement,{get(target,key){if(key==='run')return (...values:SQLInputValue[])=>{const columns=match[1]!.split(','),row=mutate(Object.fromEntries(columns.map((k,i)=>[k,values[i]!])));return row?target.run(...columns.map(k=>row[k]!)):{changes:0,lastInsertRowid:0};};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 });
}
it.each([
 ['dataset_revision_items','position',1],['dataset_revision_items','payload_snapshot','{"input":"changed","output":"Answer"}'],['dataset_revision_items','reference_provenance','{"kind":"dataset_claim","sourceId":"foreign","verdictIds":[],"actorUserIds":[],"basis":"changed"}'],
 ['evaluator_candidate_claims','command_token','foreign'],['evaluator_candidate_claims','actor_subject_id','foreign'],['evaluator_candidate_claims','truth_revision_id','rev'],
 ['evaluator_lifecycles','truth_item_count',2],['evaluator_lifecycles','request_digest','sha256:'+'a'.repeat(64)],['evaluator_lifecycles','content_digest','sha256:'+'a'.repeat(64)],
 ['evaluator_lifecycles','governed_batch_digest','sha256:'+'a'.repeat(64)],['evaluator_lifecycles','created_by_subject_id','foreign'],
 ['evaluator_lifecycle_events','reason','Other reason'],['evaluator_lifecycle_events','request_digest','sha256:'+'a'.repeat(64)],['evaluator_lifecycle_events','content_digest','sha256:'+'a'.repeat(64)],
 ['dataset_exposure_events','details','{}'],['dataset_exposure_events','subject_id','foreign'],['dataset_exposure_events','reason','Other reason'],
 ['skill_versions','rubric_provenance','human-authored']
])('rejects direct-SQL candidate forgery %s.%s and rolls back the bundle',async(table,column,value)=>{
 const f=await lifecycleFixture(),spy=alterInsert(f.db,table,row=>({...row,[column]:value,...(column==='rubric_provenance'?{rubric_provenance_declared:1}:{})}));
 try{expect(()=>createLifecycleCandidate(f.db,f.actor,f.candidateInput,f.resolution)).toThrow(column==='rubric_provenance'?/candidate lifecycle bundle mismatch/:undefined);}finally{spy.mockRestore();}
 expect(f.db.prepare('SELECT * FROM evaluator_candidate_claims').all()).toEqual([]);
 expect(f.db.prepare('SELECT * FROM evaluator_lifecycles').all()).toEqual([]);
 expect(f.db.prepare("SELECT * FROM skills WHERE criterion_id=?").all(f.candidateInput.criterionId)).toEqual([]);
});
it.each(['evaluator_lifecycle_events','dataset_exposure_events','evaluator_lifecycle_finalizations'])('requires candidate component %s',async table=>{
 const f=await lifecycleFixture(),spy=alterInsert(f.db,table,()=>null);
 try{expect(()=>createLifecycleCandidate(f.db,f.actor,f.candidateInput,f.resolution)).toThrow();}finally{spy.mockRestore();}
 expect(f.db.prepare('SELECT * FROM evaluator_candidate_claims').all()).toEqual([]);
});
it('preserves semantic provenance ordering, blocks implicit use after regression approval and rejects account erasure',async()=>{
 const f=await lifecycleFixture(),spy=alterInsert(f.db,'dataset_revision_items',row=>({...row,reference_provenance:JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(String(row.reference_provenance))).reverse()))}));
 let r;try{r=createLifecycleCandidate(f.db,f.actor,f.candidateInput,f.resolution);}finally{spy.mockRestore();}
 const id=r.projection.lifecycle.skillVersionId;
 const regress=sqliteRegressionCommands(f.db),job={projectId:f.projectId,skillVersionId:id,datasetRevisionId:r.projection.lifecycle.regressionDatasetRevisionId,actorUserId:f.userId,timeScope:'new' as const},claim=regress.claimRegressionAttempt(job,'test');if(claim.state!=='claimed')throw new Error('claim');
 const cases=f.db.prepare('SELECT id FROM dataset_revision_items WHERE revision_id=? ORDER BY position').all(job.datasetRevisionId).map(row=>({caseId:String(row.id),traceId:String(row.id),agreedLabel:'pass' as const,newLabel:'pass' as const,change:'agree' as const,rationale:'Supported'}));
 expect(regress.finishRegressionAttempt({...job,token:'test',epoch:claim.epoch},job,{id:'regression',skillVersionId:id,datasetRevisionId:job.datasetRevisionId,status:'passed',compared:cases.length,regressed:0,improved:0,flipped:0,goldenSetMissing:false,cases,error:null,createdAt:new Date().toISOString()})).toBe(true);
 expect((await f.runtime.repository.runRegressionGateForVersion(job)).version.status).toBe('calibrating');
 const defs=sqliteDefinitionCommands(f.db);expect(defs.getSkillVersion(f.projectId,id)?.status).toBe('calibrating');expect(defs.listSkillVersions(f.projectId,r.skill.id)[0]?.status).toBe('calibrating');expect(()=>defs.getCurrentSkillForCriterion(f.projectId,r.skill.criterionId)).toThrow();
 expect(()=>sqliteSuiteCommands(f.db).createEvaluatorSuiteManifest(f.projectId,{members:[{criterionVersionId:r.projection.lifecycle.criterionVersionId,skillVersionId:id}],trialPlan:null,idempotencyKey:'suite'},{})).toThrow(/authorized lifecycle/);
 expect(()=>f.db.prepare('DELETE FROM "user" WHERE id=?').run(f.userId)).toThrow();
 expect(()=>createLifecycleCandidate(f.db,{...f.actor,projectRole:'member'},f.candidateInput,f.resolution)).toThrow(/owners/);
 expect(()=>createLifecycleCandidate(f.db,f.actor,{...f.candidateInput,skillName:'Changed'},f.resolution)).toThrow(/different semantics/);
});
it('replays across worker restart, handles concurrent requests and retains typed lifecycle errors',async()=>{
 const f=await lifecycleFixture(),repo=f.runtime.evaluatorLifecycle;
 const results=await Promise.all([repo.createCandidate(f.actor,f.candidateInput,f.resolution),repo.createCandidate(f.actor,f.candidateInput,f.resolution)]);
 expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);expect(results[0]!.projection).toEqual(results[1]!.projection);
 await expect(repo.createCandidate(f.actor,{...f.candidateInput,skillName:'Changed'})).rejects.toBeInstanceOf(EvaluatorLifecycleRepositoryError);
 expect(await repo.candidateExists(f.actor,f.candidateInput.idempotencyKey)).toBe(true);
 await f.runtime.close();const restarted=await createUnseededSqliteRuntime(f.path);
 try{expect(await restarted.evaluatorLifecycle.createCandidate(f.actor,f.candidateInput)).toEqual({...results[0],replayed:true});}finally{await restarted.close();}
});
import {datasetRevisionItemDigest} from '../src/lib/dataset-revision.js';
it('rejects an altered copy even with its recomputed item digest',async()=>{
 const f=await lifecycleFixture(),spy=alterInsert(f.db,'dataset_revision_items',row=>{
  const payload={...JSON.parse(String(row.payload_snapshot)),output:'Changed output'},provenance=JSON.parse(String(row.reference_provenance));
  return {...row,payload_snapshot:JSON.stringify(payload),item_digest:datasetRevisionItemDigest({inputIdentity:{basis:'input-identity/v1',digest:String(row.input_digest)},redactedPayload:payload,referenceLabel:'pass',expectedFailStep:null,reviewProvenance:provenance,note:null})};
 });
 try{expect(()=>createLifecycleCandidate(f.db,f.actor,f.candidateInput,f.resolution)).toThrow(/copy exact governed truth/);}finally{spy.mockRestore();}
 expect(f.db.prepare('SELECT * FROM evaluator_candidate_claims').all()).toEqual([]);
});
it.each(['update','delete','event','exposure'])('rejects a trailing %s after candidate finalization in the same command',async target=>{
 const f=await lifecycleFixture(),prepare=f.db.prepare.bind(f.db);let guard='';
 const spy=vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
  const statement=prepare(sql);if(!sql.startsWith('INSERT INTO evaluator_lifecycle_finalizations('))return statement;
  return new Proxy(statement,{get(object,key){if(key==='run')return (...args:SQLInputValue[])=>{
   const result=object.run(...args),l=prepare('SELECT * FROM evaluator_lifecycles').get()!;
   try{
    if(target==='delete')prepare('DELETE FROM criterion_regression_revisions WHERE project_id=? AND criterion_version_id=?').run(f.projectId,l.criterion_version_id!);
    else if(target==='update')prepare('UPDATE criterion_regression_revisions SET revision_id=revision_id WHERE project_id=? AND criterion_version_id=?').run(f.projectId,l.criterion_version_id!);
    else {const table=target==='event'?'evaluator_lifecycle_events':'dataset_exposure_events',row=prepare('SELECT * FROM '+table+(target==='event'?'':" WHERE evidence_ref_kind='evaluator_lifecycle'")).get()!;prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));}
   }catch(error){guard=String((error as Error).message);throw error;}
   return result;
  };const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});
 });
 try{expect(()=>createLifecycleCandidate(f.db,f.actor,f.candidateInput,f.resolution)).toThrow();expect(guard).toMatch(target==='update'||target==='delete'?/finalized candidate pointer/:/unfinalized/);}finally{spy.mockRestore();}
 expect(f.db.prepare('SELECT * FROM evaluator_candidate_claims').all()).toEqual([]);
});
it('rejects declared unspecified authorship at the direct-SQL boundary',async()=>{
 const f=await lifecycleFixture(),spy=alterInsert(f.db,'skill_versions',row=>({...row,rubric_provenance:'unspecified',rubric_provenance_declared:1}));
 try{expect(()=>createLifecycleCandidate(f.db,f.actor,f.candidateInput,f.resolution)).toThrow(/declared evaluator authorship cannot be unspecified/);}finally{spy.mockRestore();}
 expect(f.db.prepare('SELECT * FROM evaluator_lifecycles').all()).toEqual([]);
});
