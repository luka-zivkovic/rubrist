import { governedTimestamp } from '../src/storage/sqlite/governed-timestamp.js';
import { expect,it } from 'vitest';
import { governedFixture } from './helpers/sqlite-governed.js';
import { sqliteGovernedInstructionCommands } from '../src/storage/sqlite/governed-instruction-commands.js';
import { createNonsealedGovernedDraft } from '../src/storage/sqlite/governed-draft-commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
import { CreateGovernedReviewBatchInputSchema } from '../src/governed-review/contracts.js';
import { executeGovernedReviewSelection } from '../src/governed-review/selection.js';
async function prepared(){
 const f=await governedFixture(),r=f.runtime.repository,dataset=await r.createDataset({projectId:f.projectId,name:'Governed review'});
 await r.importDatasetExamples({projectId:f.projectId,datasetId:dataset.id,ingestionPurpose:'dataset_example',items:[0,1,2].map(i=>({sourceTraceId:'item-'+i,input:'Question '+i,output:'Answer '+i,metadata:{hidden:'metadata'}}))});
 const revision=(await r.createDatasetRevision({projectId:f.projectId,datasetId:dataset.id,role:'iterative_development'}))!;
 const instruction=sqliteGovernedInstructionCommands(f.db).governedInstructionCreate(f.actor,{criterionVersionId:f.criterionVersionId,title:'Evidence',instructions:'Review independently',failureCodeGuidance:'',idempotencyKey:'instruction'});
 const input=CreateGovernedReviewBatchInputSchema.parse({instructionVersionId:instruction.instructionVersionId,roleIntent:'iterative_development',source:{kind:'dataset_revision',revisionId:revision.id},selection:{method:'simple_random',fixedBudget:1},reviewerUserIds:[f.userId],fixedStopAt:new Date(Date.now()+3600000).toISOString(),idempotencyKey:'draft'});
 return {...f,input,revision};
}
it('freezes exact server-selected membership, decimal digests, assignments and replay',async()=>{
 const f=await prepared(),id=createNonsealedGovernedDraft(f.db,f.actor,f.input);
 const batch=f.db.prepare('SELECT * FROM governed_review_batches WHERE id=?').get(id)!;
 const items=f.db.prepare('SELECT * FROM governed_review_batch_items WHERE batch_id=? ORDER BY draw_position').all(id),tasks=f.db.prepare('SELECT * FROM governed_review_tasks WHERE batch_id=?').all(id);
 expect(items).toHaveLength(1);expect(tasks).toHaveLength(1);expect(items[0]!.inclusion_probability).toBe('0.3333333333333333');
 const frame=f.db.prepare('SELECT id,content_digest digest FROM governed_review_items ORDER BY id').all().map(row=>({id:String(row.id),digest:String(row.digest)}));
 const selected=executeGovernedReviewSelection({frame,selection:f.input.selection,seed:String(batch.selection_seed),serveOrderSeed:String(batch.serve_order_seed)});
 expect(items[0]!.review_item_id).toBe(selected.selected[0]!.id);expect(items[0]!.serve_position).toBe(selected.serveOrder.positions[0]);
 const members=items.map(row=>({drawPosition:Number(row.draw_position),frameMemberDigest:String(row.frame_member_digest),inclusionProbability:Number(row.inclusion_probability),reviewItemId:String(row.review_item_id),samplingWeight:Number(row.sampling_weight),stratumKey:null}));
 expect(batch.draw_digest).toBe(governedContentV1Digest('governed-review-draw/v1',members));
 expect(createNonsealedGovernedDraft(f.db,f.actor,f.input,()=>Date.now()+7200000)).toBe(id);
 expect(()=>createNonsealedGovernedDraft(f.db,f.actor,{...f.input,selection:{method:'simple_random',fixedBudget:2}})).toThrow(expect.objectContaining({code:'governed_review_idempotency_conflict'}));
 expect(()=>sqliteCommand(f.db,c=>{const row={...tasks[0]!,id:'late',idempotency_key:'late',created_at:c.timestamp};c.db.prepare(`INSERT INTO governed_review_tasks(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));})).toThrow(/unfinalized owning command/);
 expect(()=>f.db.exec("UPDATE governed_review_batches SET draw_digest='rewrite'")).toThrow(/immutable/);
 expect(()=>f.db.exec('DELETE FROM governed_review_tasks')).toThrow(/project erasure/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM governed_review_batches').all()).toEqual([]);expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it.each(['manual','systematic','stratified_random'] as const)('preserves %s selections and distinct serve positions',async method=>{
 const f=await prepared(),sourceIds=f.revision.items.map(i=>i.id);
 const selection=method==='manual'?{method,selectedSourceItemIds:[sourceIds[2]!,sourceIds[0]!]}:method==='systematic'?{method,fixedBudget:2}:{method,strata:[{key:'all',definition:'All items',sourceItemIds:sourceIds,fixedBudget:2}]};
 const id=createNonsealedGovernedDraft(f.db,f.actor,{...f.input,selection});
 const row=f.db.prepare('SELECT * FROM governed_review_batches WHERE id=?').get(id)!;
 expect(row.draw_executed_by).toBe(method==='manual'?'caller_selected':'rubrist_server');
 expect(f.db.prepare('SELECT serve_position FROM governed_review_batch_items WHERE batch_id=? ORDER BY serve_position').all(id)).toEqual([{serve_position:0},{serve_position:1}]);
 expect(f.db.prepare('SELECT count(*) n FROM governed_review_tasks WHERE batch_id=?').get(id)?.n).toBe(2);
});
it.each(['assignment','late_append'])('rolls back all draft evidence on %s finalization faults',async fault=>{
 const f=await prepared();
 if(fault==='assignment')f.db.exec("CREATE TEMP TRIGGER omit_assignment BEFORE INSERT ON governed_review_tasks BEGIN SELECT RAISE(IGNORE); END");
 else f.db.exec("CREATE TEMP TRIGGER late_append AFTER INSERT ON governed_review_batch_finalizations BEGIN INSERT INTO governed_review_tasks SELECT 'late',project_id,batch_id,batch_item_id,reviewer_subject_id,reviewer_role_at_review,serve_order,content_digest,'late',request_digest,created_at FROM governed_review_tasks WHERE batch_id=NEW.batch_id LIMIT 1; END");
 expect(()=>createNonsealedGovernedDraft(f.db,f.actor,f.input)).toThrow(fault==='assignment'?/complete exact draw/:/unfinalized owning command/);
 for(const table of ['governed_review_batches','governed_review_batch_items','governed_review_tasks','governed_review_items'])expect(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0);
});
it('rejects stale owners, foreign reviewers, wrong source roles and past stopping times',async()=>{
 const f=await prepared();
 expect(()=>createNonsealedGovernedDraft(f.db,{...f.actor,projectRole:'member'},f.input)).toThrow();
 expect(()=>createNonsealedGovernedDraft(f.db,f.actor,{...f.input,reviewerUserIds:['foreign']})).toThrow();
 expect(()=>createNonsealedGovernedDraft(f.db,f.actor,{...f.input,roleIntent:'analysis_authoring'})).toThrow();
 expect(()=>createNonsealedGovernedDraft(f.db,f.actor,{...f.input,fixedStopAt:'2000-01-01T00:00:00Z'})).toThrow(/future/);
 expect(f.db.prepare('SELECT count(*) n FROM governed_review_batches').get()?.n).toBe(0);
});

it.each([
 ['2026-01-01T00:00:00Z','2026-01-01T01:00:00+02:00',false],
 ['2026-01-01T01:00:00+02:00','2026-01-01T00:00:00Z',true],
 ['2026-01-01T00:00:00Z','2026-01-01T02:00:00+02:00',false]
] as const)('compares draft windows as instants: %s through %s',async(start,end,valid)=>{
 const f=await prepared(),id=createNonsealedGovernedDraft(f.db,f.actor,f.input);
 expect(()=>sqliteCommand(f.db,c=>{
  const row=c.db.prepare('SELECT * FROM governed_review_batches WHERE id=?').get(id)!;
  Object.assign(row,{id:'window-probe',idempotency_key:'window-probe',created_at:c.timestamp,created_command_token:c.token,window_start:start,window_end:end});
  const excluded=new Set(['id','project_id','content_digest','idempotency_key','request_digest','created_by_subject_id','created_at','created_command_token']);
  const jsonFields=new Set(['population_collection_provenance','population_definition','strata']),boolFields=new Set(['evaluator_blind','peer_blind_until_labeling_closed','separation_of_duties_required']);
  const basis=Object.fromEntries(Object.entries(row).filter(([key])=>!excluded.has(key)).map(([key,value])=>[key.replace(/_([a-z])/g,(_,letter:string)=>letter.toUpperCase()),jsonFields.has(key)?JSON.parse(String(value)):boolFields.has(key)?Boolean(value):['window_start','window_end','stop_at'].includes(key)&&value!==null?governedTimestamp(String(value)):value]));
  row.content_digest=governedContentV1Digest('governed-review-batch/v1',basis);
  c.db.prepare(`INSERT INTO governed_review_batches(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
  throw new Error('valid window probe rolled back');
 })).toThrow(valid?/valid window probe rolled back/:/time window must be ascending/);
});
