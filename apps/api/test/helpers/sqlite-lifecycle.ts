import {fixture,freeze,draftStudy,studyEvent,itemEvent,assignment,type Fixture} from './sqlite-analysis.js';
import {revision} from './sqlite-taxonomy.js';
import {closeStudy} from './sqlite-closure.js';
import {sqlitePromotionCommands} from '../../src/storage/sqlite/promotion-commands.js';
import {sqliteCommand} from '../../src/storage/sqlite/command-context.js';
import type {AnalysisCriterionPromotionCreateInput} from '@rubrist/shared';
async function setup(){
 const f=await fixture();freeze(f);draftStudy(f);studyEvent(f);const taxonomy=revision(f);
 const failure=itemEvent(f,'failure_observed');assignment(f,failure);closeStudy(f);
 const commands=sqlitePromotionCommands(f.db,()=>f.now+200),actor={projectId:f.projectId,userId:f.userId,projectRole:'owner' as const};
 const candidate=commands.promotionCandidates(actor,{studyId:'study',taxonomyRevisionId:taxonomy.id,codeId:taxonomy.entries[0]!.codeId,limit:10,cursor:null}).items[0]!;
 const input:AnalysisCriterionPromotionCreateInput={studyId:'study',expectedClosureId:candidate.closureId,expectedClosureDigest:candidate.closureDigest,taxonomyId:'taxonomy',taxonomyRevisionId:taxonomy.id,expectedTaxonomyRevisionDigest:taxonomy.revisionDigest,codeId:candidate.codeId,expectedCodeEntryDigest:candidate.codeEntryDigest,criterionName:'Context completeness',criterionDefinition:'The answer includes all required context.',rationale:'Observed missing context in the closed study.',idempotencyKey:'promote',supportingObservations:[{studyItemId:candidate.studyItemId,closureItemId:candidate.closureItemId,closureItemDigest:candidate.closureItemDigest,observationEventId:candidate.observationEventId,observationEventDigest:candidate.observationEventDigest,assignmentEventId:candidate.assignmentEventId,assignmentEventDigest:candidate.assignmentEventDigest}]};
 return {...f,commands,actor,input};
}
import {sqliteGovernedInstructionCommands} from '../../src/storage/sqlite/governed-instruction-commands.js';
import {createGovernedDraft} from '../../src/storage/sqlite/governed-draft-commands.js';
import {transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView as blindView} from '../../src/storage/sqlite/governed-view-commands.js';
import {appendNonsealedGovernedTaskAction as label} from '../../src/storage/sqlite/governed-label-commands.js';
import {freezeNonsealedGovernedTruth} from '../../src/storage/sqlite/governed-freeze-commands.js';
import {CreateGovernedReviewBatchInputSchema} from '../../src/governed-review/contracts.js';
import {AnalysisPromotionRepositoryError} from '../../src/analysis-promotion/repository.js';
async function handoff(){
 const f=await setup(),promoted=f.commands.promotionCreate(f.actor,f.input),instruction=sqliteGovernedInstructionCommands(f.db).governedInstructionCreate(f.actor,{criterionVersionId:promoted.criterionVersion.id,title:'Context',instructions:'Review independently',failureCodeGuidance:'',idempotencyKey:'promotion-instruction'});
 const draft=CreateGovernedReviewBatchInputSchema.parse({instructionVersionId:instruction.instructionVersionId,roleIntent:'analysis_authoring',source:{kind:'analysis_promotion_handoff',promotionId:promoted.promotion.id},selection:{method:'simple_random',fixedBudget:3},reviewerUserIds:[f.userId],fixedStopAt:new Date(f.now+3600000).toISOString(),idempotencyKey:'handoff'});
 return {...f,promoted,draft};
}

import {EvaluatorCandidateCreateInputSchema} from '@rubrist/shared';
import {SEEDED_BINDING,bindingInput,resolvedRecordFor} from '../fixtures/execution-binding.js';
import {sha256Digest} from '../../src/lib/canonical-json.js';
export async function lifecycleFixture(){
 const f=await handoff(),batchId=createGovernedDraft(f.db,f.actor,f.draft);
 transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 for(const task of f.db.prepare('SELECT id FROM governed_review_tasks WHERE batch_id=?').all(batchId)){
  const view=blindView(f.db,f.actor,String(task.id));
  label(f.db,f.actor,String(task.id),{kind:'submit_label',input:{viewDigest:view.viewDigest,label:'pass',rationale:'Supported',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});
 }
 transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});
 transition(f.db,f.actor,batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});
 const truthId=freezeNonsealedGovernedTruth(f.db,f.actor,batchId,{expectedStateVersion:3,idempotencyKey:'freeze'});
 const truth=f.db.prepare('SELECT * FROM dataset_revisions WHERE id=?').get(truthId)!,batch=f.db.prepare('SELECT * FROM governed_review_batches WHERE id=?').get(batchId)!;
 const candidateInput=EvaluatorCandidateCreateInputSchema.parse({criterionId:f.promoted.criterion.id,criterionVersionId:f.promoted.criterionVersion.id,governedBatchId:batchId,truthDatasetRevisionId:truthId,expectedBatchDigest:batch.content_digest,expectedTruthRevisionDigest:truth.revision_digest,expectedTruthContentDigest:truth.content_digest,skillName:'Context checker',skillDescription:'Checks required context',rubricMarkdown:'Pass answers including required context.',prompt:'Evaluate the answer against the rubric.',executionBinding:bindingInput(SEEDED_BINDING),idempotencyKey:'candidate'});
 const resolution={bindingDigest:sha256Digest(SEEDED_BINDING),record:await resolvedRecordFor(SEEDED_BINDING)};
 return {...f,batchId,truthId,candidateInput,resolution};
}
