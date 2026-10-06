import {expect,it,vi} from 'vitest';
import {fixture,freeze,draftStudy,studyEvent,itemEvent,assignment,type Fixture} from './helpers/sqlite-analysis.js';
import {revision} from './helpers/sqlite-taxonomy.js';
import {closeStudy} from './helpers/sqlite-closure.js';
import {sqlitePromotionCommands} from '../src/storage/sqlite/promotion-commands.js';
import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
import type {AnalysisCriterionPromotionCreateInput} from '@rubrist/shared';
async function setup(){
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);const taxonomy=revision(f);
 const failure=itemEvent(f,'failure_observed');assignment(f,failure);closeStudy(f);
 const commands=sqlitePromotionCommands(f.db,()=>f.now+200),actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};
 const candidate=commands.promotionCandidates(actor,{studyId:'study',taxonomyRevisionId:taxonomy.id,codeId:taxonomy.entries[0]!.codeId,limit:10,cursor:null}).items[0]!;
 const input:AnalysisCriterionPromotionCreateInput={studyId:'study',expectedClosureId:candidate.closureId,expectedClosureDigest:candidate.closureDigest,taxonomyId:'taxonomy',taxonomyRevisionId:taxonomy.id,expectedTaxonomyRevisionDigest:taxonomy.revisionDigest,codeId:candidate.codeId,expectedCodeEntryDigest:candidate.codeEntryDigest,criterionName:'Context completeness',criterionDefinition:'The answer includes all required context.',rationale:'Observed missing context in the closed study.',idempotencyKey:'promote',supportingObservations:[{studyItemId:candidate.studyItemId,closureItemId:candidate.closureItemId,closureItemDigest:candidate.closureItemDigest,observationEventId:candidate.observationEventId,observationEventDigest:candidate.observationEventDigest,assignmentEventId:candidate.assignmentEventId,assignmentEventDigest:candidate.assignmentEventDigest}]};
 return {...f,commands,actor,input};
}
it('commits complete criterion, support and exposure evidence and replays the original command',async()=>{
 const f=await setup(),result=f.commands.promotionCreate(f.actor,f.input);
 expect(result.replayed).toBe(false);expect(result.supports).toHaveLength(1);expect(result.criterion.sourceKind).toBe('analysis_promotion');
 expect(f.commands.promotionCreate(f.actor,f.input)).toEqual({...result,replayed:true});
 expect(f.commands.promotionGet(f.actor,result.promotion.id)).toEqual({...result,supports:undefined,replayed:undefined});
 expect(f.commands.promotionList(f.actor,'study',{limit:10,cursor:null}).totalCount).toBe('1');
 expect(f.commands.promotionSupports(f.actor,result.promotion.id,{limit:10,cursor:null})?.totalCount).toBe(1);
 expect(f.db.prepare("SELECT count(*) n FROM dataset_exposure_events WHERE evidence_ref_kind='analysis_criterion_promotion'").get()?.n).toBe(2);
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 expect(()=>f.commands.promotionCreate(f.actor,{...f.input,rationale:'Different request'})).toThrow(/existing immutable command/);
 expect(()=>f.commands.promotionCreate(f.actor,{...f.input,idempotencyKey:'competing'})).toThrow(/existing immutable command/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM analysis_criterion_promotions').all()).toEqual([]);
});
// Intercept bound INSERT values without bypassing any database trigger or UDF.
// This exercises the same raw-SQL trust boundary as a malformed internal writer.
function alterInsert(f:Fixture,table:string,mutate:(row:Record<string,import('node:sqlite').SQLInputValue>)=>Record<string,import('node:sqlite').SQLInputValue>|null){
 const prepare=f.db.prepare.bind(f.db);
 return vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
  const statement=prepare(sql),match=new RegExp(`^INSERT INTO ${table}\\(([^)]+)\\)`).exec(sql);
  if(!match)return statement;
  return new Proxy(statement,{get(target,key){if(key==='run')return (...values:import('node:sqlite').SQLInputValue[])=>{const columns=match[1]!.split(','),row=mutate(Object.fromEntries(columns.map((k,i)=>[k,values[i]!])));return row?target.run(...columns.map(k=>row[k]!)):{changes:0,lastInsertRowid:0};};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 });
}
it.each([
 ['analysis_criterion_promotions','study_closure_digest','sha256:'+'a'.repeat(64)],
 ['analysis_criterion_promotions','taxonomy_revision_digest','sha256:'+'a'.repeat(64)],
 ['analysis_criterion_promotions','source_dataset_revision_digest','sha256:'+'a'.repeat(64)],
 ['analysis_criterion_promotions','code_entry_digest','sha256:'+'a'.repeat(64)],
 ['analysis_criterion_promotions','code_label','Forged code'],
 ['analysis_criterion_promotions','promoted_by_subject_id','foreign'],
 ['analysis_criterion_promotions','support_count',2],
 ['analysis_criterion_promotions','request_digest','sha256:'+'a'.repeat(64)],
 ['analysis_criterion_promotions','support_set_digest','sha256:'+'a'.repeat(64)],
 ['analysis_criterion_promotions','handoff_digest','sha256:'+'a'.repeat(64)],
 ['analysis_criterion_promotions','content_digest','sha256:'+'a'.repeat(64)],
 ['analysis_criterion_promotion_supports','position',1],
 ['analysis_criterion_promotion_supports','closure_item_digest','sha256:'+'a'.repeat(64)],
 ['analysis_criterion_promotion_supports','observation_author_subject_id','foreign'],
 ['analysis_criterion_promotion_supports','assignment_event_digest','sha256:'+'a'.repeat(64)],
 ['analysis_criterion_promotion_supports','source_item_digest','sha256:'+'a'.repeat(64)],
 ['analysis_criterion_promotion_supports','content_digest','sha256:'+'a'.repeat(64)],
 ['dataset_exposure_events','reason','Wrong reason'],
 ['dataset_exposure_events','details','{}'],
 ['dataset_exposure_events','subject_id','foreign'],
 ['dataset_exposure_events','idempotency_key','not-promotion'],
 ['criteria','created_by_user_id','foreign'],
 ['criterion_versions','revision',2],
 ['analysis_promotion_finalizations','command_token','foreign']
])('rejects forged direct SQL %s.%s and rolls the entire promotion back',async(table,column,value)=>{
 const f=await setup(),spy=alterInsert(f,table,row=>({...row,[column]:value}));
 try{expect(()=>f.commands.promotionCreate(f.actor,f.input)).toThrow();}finally{spy.mockRestore();}
 expect(f.db.prepare('SELECT * FROM analysis_criterion_promotions').all()).toEqual([]);
 expect(f.db.prepare("SELECT * FROM criteria WHERE source_kind='analysis_promotion'").all()).toEqual([]);
 expect(f.db.prepare("SELECT * FROM dataset_exposure_events WHERE evidence_ref_kind='analysis_criterion_promotion'").all()).toEqual([]);
});
it.each(['analysis_criterion_promotion_supports','criteria','criterion_versions','dataset_exposure_events','analysis_promotion_finalizations'])('requires every promotion bundle component: %s',async table=>{
 const f=await setup(),spy=alterInsert(f,table,()=>null);
 try{expect(()=>f.commands.promotionCreate(f.actor,f.input)).toThrow();}finally{spy.mockRestore();}
 expect(f.db.prepare('SELECT * FROM analysis_criterion_promotions').all()).toEqual([]);
});
it('requires a current owner, exact support set and current active taxonomy',async()=>{
 const f=await setup();
 expect(()=>f.commands.promotionCreate({...f.actor,projectRole:'member'},f.input)).toThrow(/owners/);
 expect(()=>f.commands.promotionCreate(f.actor,{...f.input,supportingObservations:[{...f.input.supportingObservations[0]!,assignmentEventId:'unknown'}]})).toThrow(/support/);
 revision(f,[{kind:'existing',codeId:f.input.codeId,label:'Missing context',definition:'Answer omits required context',status:'active'}]);
 expect(()=>f.commands.promotionCreate(f.actor,f.input)).toThrow(/taxonomy head/);
 expect(f.commands.promotionCandidates(f.actor,{studyId:'study',taxonomyRevisionId:f.input.taxonomyRevisionId,codeId:f.input.codeId,limit:1,cursor:null}).items).toEqual([]);
});
it('reserves criterion and exposure namespaces and forbids later supports or evaluator creation',async()=>{
 const f=await setup(),r=f.commands.promotionCreate(f.actor,f.input);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare('INSERT INTO criteria(id,project_id,stable_key,source_kind,created_at) VALUES(?,?,?,?,?)').run('native',f.projectId,'analysis-failure-code:forged','native',c.timestamp))).toThrow(/reserved/);
 const support=f.db.prepare('SELECT * FROM analysis_criterion_promotion_supports').get()!;
 expect(()=>sqliteCommand(f.db,c=>{const row={...support,id:'extra',position:1};c.db.prepare(`INSERT INTO analysis_criterion_promotion_supports(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));})).toThrow(/unfinalized/);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare('INSERT INTO skills(id,project_id,criterion_id,name,description,status,created_at) VALUES(?,?,?,?,?,?,?)').run('bad',f.projectId,r.criterion.id,'bad','bad','draft',c.timestamp))).toThrow(/lifecycle is staged/);
 const exposure=f.db.prepare("SELECT * FROM dataset_exposure_events WHERE evidence_ref_kind='analysis_criterion_promotion' LIMIT 1").get()!;
 expect(()=>sqliteCommand(f.db,c=>{const row={...exposure,id:'extra',occurred_at:c.timestamp,idempotency_key:'analysis-promotion:extra'};c.db.prepare(`INSERT INTO dataset_exposure_events(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));})).toThrow(/preallocated/);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare('DELETE FROM analysis_criterion_promotions WHERE id=?').run(r.promotion.id))).toThrow(/erasure/);
 expect(f.commands.promotionGet({...f.actor,projectId:'foreign'},r.promotion.id)).toBeNull();
});
import {sqliteGovernedInstructionCommands} from '../src/storage/sqlite/governed-instruction-commands.js';
import {createGovernedDraft} from '../src/storage/sqlite/governed-draft-commands.js';
import {transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView as blindView} from '../src/storage/sqlite/governed-view-commands.js';
import {appendNonsealedGovernedTaskAction as label} from '../src/storage/sqlite/governed-label-commands.js';
import {freezeNonsealedGovernedTruth} from '../src/storage/sqlite/governed-freeze-commands.js';
import {CreateGovernedReviewBatchInputSchema} from '../src/governed-review/contracts.js';
import {AnalysisPromotionRepositoryError} from '../src/analysis-promotion/repository.js';
async function handoff(){
 const f=await setup(),promoted=f.commands.promotionCreate(f.actor,f.input),instruction=sqliteGovernedInstructionCommands(f.db).governedInstructionCreate(f.actor,{criterionVersionId:promoted.criterionVersion.id,title:'Context',instructions:'Review independently',failureCodeGuidance:'',idempotencyKey:'promotion-instruction'});
 const draft=CreateGovernedReviewBatchInputSchema.parse({instructionVersionId:instruction.instructionVersionId,roleIntent:'analysis_authoring',source:{kind:'analysis_promotion_handoff',promotionId:promoted.promotion.id},selection:{method:'simple_random',fixedBudget:3},reviewerUserIds:[f.userId],fixedStopAt:new Date(f.now+3600000).toISOString(),idempotencyKey:'handoff'});
 return {...f,promoted,draft};
}
it('hands off all original source items through blind review to governed truth',async()=>{
 const f=await handoff(),batchId=createGovernedDraft(f.db,f.actor,f.draft);
 const batch=f.db.prepare('SELECT * FROM governed_review_batches WHERE id=?').get(batchId)!;
 expect(batch).toMatchObject({population_id:'rev',population_size:3,fixed_budget:3,source_population_kind:'analysis_promotion_handoff'});
 expect(f.promoted.supports).toHaveLength(1);expect(f.db.prepare('SELECT count(*) n FROM governed_review_batch_items WHERE batch_id=?').get(batchId)?.n).toBe(3);
 transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 for(const task of f.db.prepare('SELECT id FROM governed_review_tasks WHERE batch_id=?').all(batchId)){
  const view=blindView(f.db,f.actor,String(task.id));expect(Buffer.from(view.canonicalBytes).toString('utf8')).not.toMatch(/observationRationale|observationEvent|assignmentEvent|Missing context|taxonomyId/);
  label(f.db,f.actor,String(task.id),{kind:'submit_label',input:{viewDigest:view.viewDigest,label:'pass',rationale:'Supported',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});
 }
 transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});
 transition(f.db,f.actor,batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});
 const truth=freezeNonsealedGovernedTruth(f.db,f.actor,batchId,{expectedStateVersion:3,idempotencyKey:'freeze'});
 expect(f.db.prepare('SELECT * FROM dataset_revisions WHERE id=?').get(truth)).toMatchObject({role:'analysis_authoring',provenance_level:'governed_blind',criterion_version_id:f.promoted.criterionVersion.id,item_count:3});
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it.each(['population_size','population_definition','population_collection_provenance','population_id','role_intent'])('rejects a forged handoff %s atomically',async column=>{
 const f=await handoff(),spy=alterInsert(f,'governed_review_batches',row=>({...row,[column]:column==='population_size'?1:column==='role_intent'?'iterative_development':column==='population_id'?'unknown':'{}'}));
 try{expect(()=>createGovernedDraft(f.db,f.actor,f.draft)).toThrow();}finally{spy.mockRestore();}
 expect(f.db.prepare('SELECT * FROM governed_review_batches').all()).toEqual([]);
});
it('keeps analysis populations out of generic dataset review and enforces exact handoff ownership',async()=>{
 const f=await handoff();
 expect(()=>createGovernedDraft(f.db,f.actor,{...f.draft,source:{kind:'dataset_revision',revisionId:'rev'}})).toThrow();
 expect(()=>createGovernedDraft(f.db,f.actor,{...f.draft,source:{kind:'analysis_promotion_handoff',promotionId:'foreign'}})).toThrow();
 expect(()=>f.db.prepare('SELECT analysis_promotion_bundle_valid_v1(?,?)').get(f.projectId,f.promoted.promotion.id)).toThrow(/authorized/);
});
it('preserves replay and typed conflicts across the worker boundary under concurrent requests',async()=>{
 const f=await setup(),r=f.runtime.analysisPromotions;
 const values=await Promise.all([r.createPromotion(f.actor,f.input),r.createPromotion(f.actor,f.input)]);
 expect(values.map(v=>v.replayed).sort()).toEqual([false,true]);expect(values[0]!.promotion.id).toBe(values[1]!.promotion.id);
 expect(await r.getPromotion(f.actor,values[0]!.promotion.id)).toMatchObject({promotion:values[0]!.promotion});
 await expect(r.createPromotion(f.actor,{...f.input,rationale:'Changed'})).rejects.toBeInstanceOf(AnalysisPromotionRepositoryError);
 await expect(r.createPromotion(f.actor,{...f.input,rationale:'Changed'})).rejects.toMatchObject({code:'analysis_promotion_idempotency_conflict'});
});
it.each(['criterion_authoring','example_selection'])('rejects unreserved evidence references for analysis %s exposure',async activity=>{
 const f=await setup();expect(()=>sqliteCommand(f.db,c=>c.db.prepare("INSERT INTO dataset_exposure_events(id,project_id,revision_id,kind,exposure_class,activity,subject_kind,subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,details,idempotency_key,occurred_at) VALUES('orphan',?,'rev','development_use','development',?,'person','subject',?,'other','other','{}','unreserved',?)").run(f.projectId,activity,f.userId,c.timestamp))).toThrow(/exact promotion evidence/);
});
it.each(['support','exposure','version','batch'])('rejects a trailing %s write after finalization in the same command',async target=>{
 const f=await setup(),prepare=f.db.prepare.bind(f.db);let guardMessage='';
 const spy=vi.spyOn(f.db,'prepare').mockImplementation(sql=>{
  const statement=prepare(sql);if(!sql.startsWith('INSERT INTO analysis_promotion_finalizations('))return statement;
  return new Proxy(statement,{get(object,key){if(key==='run')return (...args:import('node:sqlite').SQLInputValue[])=>{
   const result=object.run(...args),p=prepare('SELECT * FROM analysis_criterion_promotions').get()!;
   try{if(target==='batch')prepare('INSERT INTO governed_review_batches(id,project_id,criterion_version_id) VALUES(?,?,?)').run('trailing',f.projectId,p.criterion_version_id!);
   else {const table=target==='support'?'analysis_criterion_promotion_supports':target==='exposure'?'dataset_exposure_events':'criterion_versions',where=target==='support'?'':target==='exposure'?" WHERE evidence_ref_kind='analysis_criterion_promotion'":" WHERE source_kind='analysis_promotion'",row=prepare('SELECT * FROM '+table+where+' LIMIT 1').get()!;prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));}
   }catch(error){guardMessage=String((error as Error).message);throw error;}
   return result;
  };const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;}});
 });
 try{expect(()=>f.commands.promotionCreate(f.actor,f.input)).toThrow(/immutable governed evidence/);expect(guardMessage).toMatch(target==='batch'?/previously committed/:target==='exposure'?/preallocated/:/unfinalized/);}finally{spy.mockRestore();}
 expect(f.db.prepare('SELECT * FROM analysis_criterion_promotions').all()).toEqual([]);
});
it('compares promotion pagination cursors at microsecond precision',async()=>{
 const f=await setup(),r=f.commands.promotionCreate(f.actor,f.input),base=r.promotion.createdAt.slice(0,23);
 const cursor=(tail:string)=>Buffer.from(JSON.stringify({v:1,kind:'promotion',createdAt:base+tail+'Z',id:r.promotion.id})).toString('base64url');
 expect(f.commands.promotionList(f.actor,'study',{limit:10,cursor:cursor('001')}).items).toHaveLength(1);
 expect(f.commands.promotionList(f.actor,'study',{limit:10,cursor:cursor('000')}).items).toHaveLength(0);
});
