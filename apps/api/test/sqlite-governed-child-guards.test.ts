import {expect,it} from 'vitest';
import {governedDraftFixture} from './helpers/sqlite-governed-draft.js';
import {createNonsealedGovernedDraft} from '../src/storage/sqlite/governed-draft-commands.js';
import {transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView} from '../src/storage/sqlite/governed-view-commands.js';
import {appendNonsealedGovernedTaskAction as label} from '../src/storage/sqlite/governed-label-commands.js';
import {appendNonsealedGovernedAlignment as alignment} from '../src/storage/sqlite/governed-alignment-commands.js';
import {appendNonsealedGovernedAdjudication as adjudicate} from '../src/storage/sqlite/governed-adjudication-commands.js';
import {freezeNonsealedGovernedTruth} from '../src/storage/sqlite/governed-freeze-commands.js';
async function prepared(kind:string){
 const f=await governedDraftFixture();
 function batch(key:string,outcome:'pass'|'cannot_determine'){
  const id=createNonsealedGovernedDraft(f.db,f.actor,{...f.input,idempotencyKey:key});transition(f.db,f.actor,id,'open',{expectedStateVersion:0,idempotencyKey:'open'});
  const task=f.db.prepare('SELECT id,batch_item_id FROM governed_review_tasks WHERE batch_id=?').get(id)!,view=getOrCreateNonsealedBlindView(f.db,f.actor,String(task.id));
  const result=label(f.db,f.actor,String(task.id),{kind:'submit_label',input:{expectedStreamVersion:1,idempotencyKey:'label',viewDigest:view.viewDigest,label:outcome,rationale:'Supported',failureCodes:[]}});
  transition(f.db,f.actor,id,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});return {id,itemId:String(task.batch_item_id),labelId:result.activeLabelId!};
 }
 const own=batch('own',kind==='truth'?'pass':'cannot_determine'),foreign=batch('foreign','pass');
 const {user}=await f.runtime.auth.api.signUpEmail({body:{email:'adjudicator@example.test',password:'synthetic-long-password',name:'Adjudicator'}});
 f.db.prepare('INSERT INTO project_members VALUES(?,?,?,?,?)').run('adjudicator',f.projectId,user.id,'owner',new Date().toISOString());
 return {...f,own,foreign,adjudicator:{...f.actor,userId:user.id}};
}
it.each(['alignment','adjudication','truth'])('rejects a real foreign-item label during an unfinalized %s snapshot',async kind=>{
 const f=await prepared(kind),table=kind==='alignment'?'governed_review_alignment_event_labels':kind==='adjudication'?'governed_review_adjudication_labels':'governed_dataset_truth_link_labels',parent=kind==='alignment'?'alignment_event_id':kind==='adjudication'?'adjudication_id':'truth_link_id';
 f.db.function('test_foreign_label',()=>f.foreign.labelId);
 f.db.exec(`CREATE TRIGGER test_foreign_child BEFORE INSERT ON ${table} WHEN NEW.label_id<>test_foreign_label() BEGIN INSERT INTO ${table}(project_id,${parent},label_id) VALUES(NEW.project_id,NEW.${parent},test_foreign_label()); END`);
 let write:()=>unknown;
 if(kind==='alignment'){transition(f.db,f.actor,f.own.id,'open_alignment',{expectedStateVersion:2,idempotencyKey:'alignment'});write=()=>alignment(f.db,f.actor,f.own.id,{expectedAlignmentVersion:0,kind:'comment_recorded',content:'Review',idempotencyKey:'comment'});}
 else if(kind==='adjudication'){transition(f.db,f.actor,f.own.id,'start_adjudication',{expectedStateVersion:2,idempotencyKey:'adjudicate'});write=()=>adjudicate(f.db,f.adjudicator,f.own.id,f.own.itemId,{expectedHeadAdjudicationId:null,decision:'pass',basis:'Independent',rationale:'Supported',idempotencyKey:'decision'});}
 else{transition(f.db,f.actor,f.own.id,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});write=()=>freezeNonsealedGovernedTruth(f.db,f.actor,f.own.id,{expectedStateVersion:3,idempotencyKey:'freeze'});}
 expect(write).toThrow(/exact|label|snapshot/);expect(f.db.prepare('SELECT * FROM '+table).all()).toEqual([]);
 f.db.exec('DROP TRIGGER test_foreign_child');expect(write).not.toThrow();
});
