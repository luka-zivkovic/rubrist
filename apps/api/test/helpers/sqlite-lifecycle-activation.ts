import {sqliteCommand} from '../../src/storage/sqlite/command-context.js';
import {EvaluatorLifecycleActivateInputSchema,type EvaluatorCandidateCreateResult} from '@rubrist/shared';
import {lifecycleFixture} from './sqlite-lifecycle.js';
import {createLifecycleCandidate} from '../../src/storage/sqlite/lifecycle-candidate.js';
import {sqliteRegressionCommands} from '../../src/storage/sqlite/regression-commands.js';
import {createGovernedSealedIntake} from '../../src/storage/sqlite/governed-sealed-intake-commands.js';
import {createGovernedDraft} from '../../src/storage/sqlite/governed-draft-commands.js';
import {transitionNonsealedGovernedBatch as transition,getOrCreateNonsealedBlindView as view} from '../../src/storage/sqlite/governed-view-commands.js';
import {appendNonsealedGovernedTaskAction as label} from '../../src/storage/sqlite/governed-label-commands.js';
import {freezeNonsealedGovernedTruth} from '../../src/storage/sqlite/governed-freeze-commands.js';
import {CreateGovernedReviewBatchInputSchema} from '../../src/governed-review/contracts.js';
import {createCalibrationRun} from '../../src/storage/sqlite/calibration-run-commands.js';
import {sqliteCalibrationClaimCommands} from '../../src/storage/sqlite/calibration-claim-commands.js';
import {sqliteCalibrationExecutionCommands} from '../../src/storage/sqlite/calibration-execution-commands.js';
import {sqliteCalibrationMintCommands} from '../../src/storage/sqlite/calibration-mint-commands.js';
type Fixture=Awaited<ReturnType<typeof lifecycleFixture>>;
export function regressionEvidence(f:Fixture,candidate:EvaluatorCandidateCreateResult){
 const commands=sqliteRegressionCommands(f.db),l=candidate.projection.lifecycle,job={projectId:f.projectId,skillVersionId:l.skillVersionId,datasetRevisionId:l.regressionDatasetRevisionId,timeScope:'new' as const,actorUserId:f.userId};
 const claim=commands.claimRegressionAttempt(job,'test');if(claim.state!=='claimed')throw new Error('Expected claim');
 const cases=f.db.prepare('SELECT id,reference_label FROM dataset_revision_items WHERE revision_id=? ORDER BY position').all(l.regressionDatasetRevisionId).map(i=>({caseId:String(i.id),traceId:String(i.id),agreedLabel:i.reference_label as 'pass'|'fail',newLabel:i.reference_label as 'pass'|'fail',change:'agree' as const,rationale:'Supported'}));
 const result={id:'reg_'+l.skillVersionId,skillVersionId:l.skillVersionId,datasetRevisionId:l.regressionDatasetRevisionId,status:'passed' as const,compared:cases.length,regressed:0,improved:0,flipped:0,cases,goldenSetMissing:false,error:null,createdAt:new Date().toISOString()};
 if(!commands.finishRegressionAttempt({...job,token:'test',epoch:claim.epoch},job,result))throw new Error('Regression did not commit');return result;
}
export function calibrationEvidence(f:Fixture,candidate:EvaluatorCandidateCreateResult,revisionId:string){
 const version=candidate.skill.currentVersion,run=createCalibrationRun(f.db,f.actor,{datasetRevisionId:revisionId,skillVersionId:version.id,positiveClass:'fail',trialPlan:{kind:'single',trialsPerItem:1},suiteBinding:null,idempotencyKey:version.id});
 const claim=sqliteCalibrationClaimCommands(f.db).claimRun(run.runId,'worker',60000)!,execution=sqliteCalibrationExecutionCommands(f.db);
 execution.authorizeRun(claim);
 for(let item=execution.getNextAttempt(claim);item;item=execution.getNextAttempt(claim)){
  execution.recordProviderCallStarted(claim,item.attemptId);execution.completeAttempt(claim,item.attemptId,{result:{state:'outcome',outcome:'pass'},attemptState:'terminal',providerObservation:{provider:version.executionBinding.provider,observedModel:version.executionBinding.modelId,observedVersion:null,systemFingerprint:null,upstreamProvider:null}});
 }
 return sqliteCalibrationMintCommands(f.db).finalizeRun(claim);
}
export function activationInput(candidate:EvaluatorCandidateCreateResult,calibration:ReturnType<typeof calibrationEvidence>,regression:ReturnType<typeof regressionEvidence>){
 const h=candidate.projection.currentEvent,a=calibration.artifactCopy;
 return EvaluatorLifecycleActivateInputSchema.parse({expectedState:h.state,expectedSequence:h.sequence,expectedEventId:h.id,expectedEventDigest:h.contentDigest,calibrationArtifactId:calibration.artifact.artifactId,expectedCalibrationArtifactDigest:a.artifactDigest,expectedCalibrationEvidenceDigest:calibration.artifact.evidenceDigest,regressionRunId:regression.id,expectedPriorActiveSkillVersionId:null,expectedPriorActiveEventId:null,expectedPriorActiveEventDigest:null,rationale:'Exact complete retained evidence reviewed.',idempotencyKey:'activate:'+candidate.skill.currentVersion.id});
}
export async function activationFixture(precreateSecond=false){
 const f=await lifecycleFixture(),candidate=createLifecycleCandidate(f.db,f.actor,f.candidateInput,f.resolution),reviewers:string[]=[];
 const second=precreateSecond?createLifecycleCandidate(f.db,f.actor,{...f.candidateInput,idempotencyKey:'second'},f.resolution):null;
 for(let i=0;i<3;i++){const {user}=await f.runtime.auth.api.signUpEmail({body:{email:`sealed${i}@example.test`,password:'synthetic-long-password',name:'Independent'}});f.db.prepare('INSERT INTO project_members VALUES(?,?,?,?,?)').run('sealed-member-'+i,f.projectId,user.id,i===2?'owner':'member',new Date().toISOString());reviewers.push(user.id);}
 const secondRegression=second?regressionEvidence(f,second):null;
 sqliteCommand(f.db,()=>undefined,()=>Number(f.db.prepare('SELECT last_ms FROM rubrist_command_clock').get()!.last_ms)+1);
 const intake=createGovernedSealedIntake(f.db,{...f.actor,userId:reviewers[2]!},{populationDefinition:'Independent sealed cohort',timeWindow:{startInclusive:'2026-01-01T00:00:00Z',endExclusive:'2026-01-02T00:00:00Z'},items:[{clientItemId:'one',input:'Sealed one',output:'Independent answer'},{clientItemId:'two',input:'Sealed two',output:'Independent answer'}],idempotencyKey:'sealed'});
 const input=CreateGovernedReviewBatchInputSchema.parse({...f.draft,roleIntent:'sealed_validation',source:{kind:'sealed_intake',intakeId:intake.intakeId},selection:{method:'simple_random',fixedBudget:1},reviewerUserIds:reviewers.slice(0,2),idempotencyKey:'sealed-draft'}),batchId=createGovernedDraft(f.db,f.actor,input);
 transition(f.db,f.actor,batchId,'open',{expectedStateVersion:0,idempotencyKey:'open'});
 for(const task of f.db.prepare('SELECT t.id,s.account_user_id FROM governed_review_tasks t JOIN governed_reviewer_subjects s ON s.id=t.reviewer_subject_id WHERE t.batch_id=?').all(batchId)){
  const actor={...f.actor,userId:String(task.account_user_id),projectRole:'member' as const},artifact=view(f.db,actor,String(task.id));
  label(f.db,actor,String(task.id),{kind:'submit_label',input:{viewDigest:artifact.viewDigest,label:'pass',rationale:'Supported',failureCodes:[],expectedStreamVersion:1,idempotencyKey:'label'}});
 }
 transition(f.db,f.actor,batchId,'close_labeling',{expectedStateVersion:1,idempotencyKey:'close'});transition(f.db,f.actor,batchId,'finalize',{expectedStateVersion:2,idempotencyKey:'resolve'});
 const sealedRevisionId=freezeNonsealedGovernedTruth(f.db,f.actor,batchId,{expectedStateVersion:3,idempotencyKey:'freeze'}),regression=regressionEvidence(f,candidate),calibration=calibrationEvidence(f,candidate,sealedRevisionId);
 return {...f,candidate,second,secondRegression,sealedRevisionId,regression,calibration,activation:activationInput(candidate,calibration,regression)};
}
