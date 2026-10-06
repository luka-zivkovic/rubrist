import {CreateSkillVersionInputSchema} from '@rubrist/shared';
import { governedSealedDraftFixture } from './sqlite-governed-sealed-draft.js';
import { createGovernedDraft } from '../../src/storage/sqlite/governed-draft-commands.js';
import { transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView as view } from '../../src/storage/sqlite/governed-view-commands.js';
import { appendNonsealedGovernedTaskAction as action } from '../../src/storage/sqlite/governed-label-commands.js';
import { freezeNonsealedGovernedTruth as freeze } from '../../src/storage/sqlite/governed-freeze-commands.js';
import { sqliteSkillCommands } from '../../src/storage/sqlite/skill-commands.js';
import { sqliteResolutionStore } from '../../src/storage/sqlite/resolution-commands.js';
import { sqliteCommand } from '../../src/storage/sqlite/command-context.js';
import { SEEDED_BINDING,bindingInput,resolvedRecordFor } from '../fixtures/execution-binding.js';
import type { CreateBinaryCalibrationRunInput } from '../../src/binary-calibration/repository.js';
/** All resolution probes are local stubs. This fixture never calls a provider. */
export async function calibrationFixture(){
 const f=await governedSealedDraftFixture(true);
 const skillId=String(f.db.prepare('SELECT skill_id FROM skill_versions WHERE criterion_version_id=?').get(f.criterionVersionId)!.skill_id);
 const version=sqliteSkillCommands(f.db).insertPendingSkillVersion(skillId,CreateSkillVersionInputSchema.parse({criterionVersionId:f.criterionVersionId,rubricMarkdown:'Pass grounded answers.',prompt:'Evaluate the answer against the rubric.',verdictKind:'binary',executionBinding:bindingInput(SEEDED_BINDING)}),{projectId:f.projectId,actorUserId:f.userId});
 const record=await resolvedRecordFor(version.executionBinding);
 sqliteCommand(f.db,()=>sqliteResolutionStore(f.db).save(f.projectId,version.id,version.executionBinding,record));
 const batchId=createGovernedDraft(f.db,f.actor,f.input);transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 for(const task of f.db.prepare('SELECT t.id,s.account_user_id FROM governed_review_tasks t JOIN governed_reviewer_subjects s ON s.id=t.reviewer_subject_id WHERE t.batch_id=? ORDER BY t.id').all(batchId)){
  const actor={...f.actor,userId:String(task.account_user_id),projectRole:'member' as const},taskId=String(task.id),artifact=view(f.db,actor,taskId);
  action(f.db,actor,taskId,{kind:'submit_label',input:{viewDigest:artifact.viewDigest,label:'pass',rationale:'Independent evidence',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});
 }
 transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});
 transition(f.db,f.actor,batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});
 const revisionId=freeze(f.db,f.actor,batchId,{expectedStateVersion:3,idempotencyKey:'freeze'});
 const calibrationInput:CreateBinaryCalibrationRunInput={datasetRevisionId:revisionId,skillVersionId:version.id,positiveClass:'fail',trialPlan:{kind:'single',trialsPerItem:1},suiteBinding:null,idempotencyKey:'calibration'};
 return {...f,version,batchId,revisionId,calibrationInput};
}
