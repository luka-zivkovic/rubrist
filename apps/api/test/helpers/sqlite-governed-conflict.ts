import { governedDraftFixture } from './sqlite-governed-draft.js';
import { createNonsealedGovernedDraft } from '../../src/storage/sqlite/governed-draft-commands.js';
import { transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView } from '../../src/storage/sqlite/governed-view-commands.js';
import { appendNonsealedGovernedTaskAction } from '../../src/storage/sqlite/governed-label-commands.js';
export async function governedConflictFixture(){
 const f=await governedDraftFixture(),batchId=createNonsealedGovernedDraft(f.db,f.actor,f.input),taskId=String(f.db.prepare('SELECT id FROM governed_review_tasks WHERE batch_id=?').get(batchId)!.id);
 transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 const view=getOrCreateNonsealedBlindView(f.db,f.actor,taskId);
 const label=appendNonsealedGovernedTaskAction(f.db,f.actor,taskId,{kind:'submit_label',input:{expectedStreamVersion:1,idempotencyKey:'label',viewDigest:view.viewDigest,label:'cannot_determine',rationale:'Needs adjudication',failureCodes:[]}});
 transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});
 return {...f,batchId,taskId,labelId:label.activeLabelId!,batchItemId:String(f.db.prepare('SELECT batch_item_id FROM governed_review_tasks WHERE id=?').get(taskId)!.batch_item_id)};
}
