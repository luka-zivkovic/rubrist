import { stableId } from '../../governed-review/storage-values.js';
import type { DatabaseSync } from 'node:sqlite';
import { CreateGovernedReviewInstructionInputSchema,type GovernedReviewInstructionProjection } from '../../governed-review/contracts.js';
import { GovernedReviewConflictError,GovernedReviewForbiddenError,GovernedReviewIdempotencyConflictError,GovernedReviewNotFoundError } from '../../governed-review/errors.js';
import type { GovernedReviewRepository,GovernedReviewActor } from '../../governed-review/repository.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { populationSubject } from './population-build.js';
import { sqliteCommand } from './command-context.js';
type Args<K extends keyof GovernedReviewRepository>=Parameters<GovernedReviewRepository[K]>;
const allowedLabels=['pass','fail','cannot_determine'] as const;
function instruction(row:Record<string,unknown>):GovernedReviewInstructionProjection {
 return {instructionVersionId:String(row.id),criterionVersionId:String(row.criterion_version_id),revision:Number(row.revision),predecessorInstructionVersionId:row.predecessor_instruction_version_id===null?null:String(row.predecessor_instruction_version_id),title:String(row.title),instructions:String(row.instructions),failureCodeGuidance:String(row.failure_code_guidance),allowedLabels:[...allowedLabels],instructionDigest:String(row.content_digest),createdAt:String(row.created_at)};
}
export function governedReviewAccess(db:DatabaseSync,actor:GovernedReviewActor,owner=false):void {
 const role=db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(actor.projectId,actor.userId)?.role;
 if((role!=='owner'&&role!=='member')||(owner&&(role!=='owner'||actor.projectRole!=='owner')))throw new GovernedReviewForbiddenError();
}
export function sqliteGovernedInstructionCommands(db:DatabaseSync,clock=Date.now){
 return {
  governedInstructions(...[actor,criterionVersionId]:Args<'listInstructions'>){return sqliteCommand(db,()=>{governedReviewAccess(db,actor);return db.prepare('SELECT * FROM review_instruction_versions WHERE project_id=? AND (? IS NULL OR criterion_version_id=?) ORDER BY governed_utf16_sort_key_v1(criterion_version_id),revision,governed_utf16_sort_key_v1(id)').all(actor.projectId,criterionVersionId??null,criterionVersionId??null).map(instruction);},clock);},
  governedInstructionCreate(...[actor,raw]:Args<'createInstruction'>){const input=CreateGovernedReviewInstructionInputSchema.parse(raw);
   try{return sqliteCommand(db,c=>{
    governedReviewAccess(db,actor,true);const subjectId=populationSubject(db,actor,c.timestamp),id=stableId('griv',actor.projectId,input.idempotencyKey);
    const existing=db.prepare('SELECT * FROM review_instruction_versions WHERE id=? AND project_id=?').get(id,actor.projectId);
    const predecessor=input.predecessorInstructionVersionId?db.prepare('SELECT * FROM review_instruction_versions WHERE id=? AND project_id=? AND criterion_version_id=?').get(input.predecessorInstructionVersionId,actor.projectId,input.criterionVersionId):null;
    if(input.predecessorInstructionVersionId&&!predecessor)throw new GovernedReviewNotFoundError();
    const revision=predecessor?Number(predecessor.revision)+1:1;
    const basis={allowedLabels:[...allowedLabels],criterionVersionId:input.criterionVersionId,failureCodeGuidance:input.failureCodeGuidance,id,instructions:input.instructions,predecessorInstructionVersionId:input.predecessorInstructionVersionId??null,revision,title:input.title};
    const contentDigest=governedJsonTextDigest('review-instruction/v1',JSON.stringify(basis));
    if(existing){if(existing.content_digest!==contentDigest)throw new GovernedReviewIdempotencyConflictError();return instruction(existing);}
    c.db.prepare(`INSERT INTO review_instruction_versions(id,project_id,criterion_version_id,revision,predecessor_instruction_version_id,title,instructions,allowed_labels,failure_code_guidance,content_digest,created_by_subject_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
     .run(id,actor.projectId,input.criterionVersionId,revision,input.predecessorInstructionVersionId??null,input.title,input.instructions,JSON.stringify(allowedLabels),input.failureCodeGuidance,contentDigest,subjectId,c.timestamp);
    return instruction(c.db.prepare('SELECT * FROM review_instruction_versions WHERE id=?').get(id)!);
   },clock);}catch(error){if((error as {code?:unknown})?.code==='ERR_SQLITE_ERROR'){
    if(error instanceof Error&&/UNIQUE constraint/i.test(error.message))throw new GovernedReviewIdempotencyConflictError();
    throw new GovernedReviewConflictError('governed_review_transition_conflict','Review instruction conflicts with retained criterion history');
   }throw error;}
  }
 };
}
