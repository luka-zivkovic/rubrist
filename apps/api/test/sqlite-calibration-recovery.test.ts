import {expect,it} from 'vitest';
import type {DatabaseSync} from 'node:sqlite';
import {activationFixture} from './helpers/sqlite-lifecycle-activation.js';
import {calibrationFixture} from './helpers/sqlite-calibration.js';
import {createCalibrationRun} from '../src/storage/sqlite/calibration-run-commands.js';
import {sqliteCalibrationClaimCommands} from '../src/storage/sqlite/calibration-claim-commands.js';
import {sqliteCalibrationExecutionCommands} from '../src/storage/sqlite/calibration-execution-commands.js';
import {sqliteCalibrationMintCommands} from '../src/storage/sqlite/calibration-mint-commands.js';
import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
import {BinaryCalibrationRepositoryError,type BinaryCalibrationExecutionRepository} from '../src/binary-calibration/repository.js';
import type {BinaryCalibrationProviderExecutor} from '../src/binary-calibration/provider.js';
import {processBinaryCalibrationRun} from '../src/binary-calibration/worker.js';
import {verifyBinaryCalibrationPrivateLedgerForArtifact} from '../src/lib/binary-calibration.js';

/** The worker's repository over one connection and a controlled command clock. */
function repository(db:DatabaseSync,clock:()=>number):BinaryCalibrationExecutionRepository{
 const claims=sqliteCalibrationClaimCommands(db,clock),exec=sqliteCalibrationExecutionCommands(db,clock),mint=sqliteCalibrationMintCommands(db,clock);
 return {listRunnableRunIds:async(...a)=>claims.listRunnableRunIds(...a),claimRun:async(...a)=>claims.claimRun(...a),heartbeatClaim:async(...a)=>claims.heartbeatClaim(...a),getRecheckTarget:async(...a)=>claims.getRecheckTarget(...a),recordRecheck:async(...a)=>claims.recordRecheck(...a),rejectBeforeAuthorization:async(...a)=>claims.rejectBeforeAuthorization(...a),authorizeRun:async(...a)=>exec.authorizeRun(...a),recoverStartedAttempts:async(...a)=>exec.recoverStartedAttempts(...a),getNextAttempt:async(...a)=>exec.getNextAttempt(...a),recordProviderCallStarted:async(...a)=>exec.recordProviderCallStarted(...a),completeAttempt:async(...a)=>exec.completeAttempt(...a),finalizeRun:async(...a)=>mint.finalizeRun(...a),finalizeLifecycleForbiddenRun:async(...a)=>mint.finalizeLifecycleForbiddenRun(...a),markRecoveryRequired:async(...a)=>claims.markRecoveryRequired(...a)};
}
function countingExecutor(provider:string){const dispatched:string[]=[];const execute:BinaryCalibrationProviderExecutor=async({attempt,beforePhysicalCall})=>{await beforePhysicalCall();dispatched.push(attempt.attemptId);return {outcome:'pass',providerObservation:{provider,observedModel:null,observedVersion:null,systemFingerprint:null,upstreamProvider:null}};};return {execute,dispatched};}
const lastMs=(db:DatabaseSync)=>Number(db.prepare('SELECT last_ms FROM rubrist_command_clock').get()!.last_ms);

it.each(['not_started','started'] as const)('ends a %s attempt of a run retired after authorization in one incomplete mint without dispatch',async attemptState=>{
 const f=await activationFixture(),version=f.candidate.skill.currentVersion,lifecycle=f.runtime.evaluatorLifecycle;
 let now=lastMs(f.db)+10;const clock=()=>now;
 const run=createCalibrationRun(f.db,f.actor,{datasetRevisionId:f.sealedRevisionId,skillVersionId:version.id,positiveClass:'fail',trialPlan:{kind:'single',trialsPerItem:1},suiteBinding:null,idempotencyKey:'second-run'},clock);
 const claims=sqliteCalibrationClaimCommands(f.db,clock),exec=sqliteCalibrationExecutionCommands(f.db,clock),mint=sqliteCalibrationMintCommands(f.db,clock);
 const a=claims.claimRun(run.runId,'A',1000)!;exec.authorizeRun(a);
 if(attemptState==='started'){const item=exec.getNextAttempt(a)!;exec.recordProviderCallStarted(a,item.attemptId);}
 // While its lifecycle still authorizes it, a run is untouched by the recovery.
 expect(mint.finalizeLifecycleForbiddenRun(a)).toBeNull();
 expect(f.db.prepare("SELECT count(*) n FROM binary_calibration_attempts WHERE run_id=? AND accounting_state='pending'").get(run.runId)!.n).toBe(1);
 expect(f.db.prepare('SELECT count(*) n FROM binary_calibration_revision_leases WHERE run_id=?').get(run.runId)!.n).toBe(1);
 const head=(await lifecycle.getLifecycle(f.actor,version.id))!.currentEvent;
 await lifecycle.retire(f.actor,version.id,{expectedState:head.state,expectedSequence:head.sequence,expectedEventId:head.id,expectedEventDigest:head.contentDigest,rationale:'Retire exact evaluator.',idempotencyKey:'retire:'+head.id} as never);
 now=Math.max(now,lastMs(f.db))+5000;// A's claim expires: the worker crashed.
 // The resumed authorization is the same typed refusal PostgreSQL reports.
 const probe=claims.claimRun(run.runId,'probe',1000)!;
 let refusal:unknown;try{exec.authorizeRun(probe);}catch(error){refusal=error;}
 expect(refusal).toBeInstanceOf(BinaryCalibrationRepositoryError);expect(refusal).toMatchObject({code:'ineligible'});
 now+=5000;
 const counting=countingExecutor(version.executionBinding.provider),repo=repository(f.db,clock);
 const minted=(await processBinaryCalibrationRun({repository:repo,executeProvider:counting.execute,runId:run.runId,workerId:'B',claimTtlMs:60000}))!;
 expect(counting.dispatched).toEqual([]);
 expect(minted.artifact).toMatchObject({status:'incomplete',incompleteReasons:['trial_incomplete'],trials:[{outcomes:attemptState==='started'?{planned:1,classified:0,errored:1,notAttempted:0,providerCalls:1,errors:[{code:'outcome_unknown',count:1}]}:{planned:1,classified:0,errored:0,notAttempted:1,providerCalls:0,errors:[]}}]});
 expect(minted.run).toMatchObject({state:'incomplete',accountedObservations:1});
 expect(f.db.prepare('SELECT attempt_state,terminal_evaluator_outcome,error_code,physical_provider_calls FROM binary_calibration_attempts WHERE run_id=?').all(run.runId)).toEqual([attemptState==='started'?{attempt_state:'started',terminal_evaluator_outcome:'errored',error_code:'outcome_unknown',physical_provider_calls:1}:{attempt_state:'not_started',terminal_evaluator_outcome:'not_attempted',error_code:null,physical_provider_calls:0}]);
 const ledger=JSON.parse(Buffer.from(f.db.prepare('SELECT canonical_bytes FROM binary_calibration_private_ledgers WHERE run_id=?').get(run.runId)!.canonical_bytes as Uint8Array).toString('utf8'));
 expect(verifyBinaryCalibrationPrivateLedgerForArtifact(ledger,minted.artifact).ledger.records).toHaveLength(1);
 expect(f.db.prepare('SELECT count(*) n FROM binary_calibration_revision_leases').get()!.n).toBe(0);
 const stored=f.db.prepare('SELECT canonical_bytes,artifact_digest FROM binary_calibration_artifacts WHERE run_id=?').all(run.runId);expect(stored).toHaveLength(1);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare('UPDATE binary_calibration_artifacts SET status=? WHERE run_id=?').run('complete',run.runId),clock)).toThrow();
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare('DELETE FROM binary_calibration_artifacts WHERE run_id=?').run(run.runId),clock)).toThrow();
 // Replays neither dispatch nor mint again.
 await expect(processBinaryCalibrationRun({repository:repo,executeProvider:counting.execute,runId:run.runId,workerId:'C',claimTtlMs:60000})).resolves.toBeNull();
 expect(()=>mint.finalizeLifecycleForbiddenRun(probe)).toThrow(expect.objectContaining({code:'state_conflict'}));
 expect(counting.dispatched).toEqual([]);expect(f.db.prepare('SELECT canonical_bytes,artifact_digest FROM binary_calibration_artifacts WHERE run_id=?').all(run.runId)).toEqual(stored);
 // The revision is free again, and the incomplete artifact makes nothing admissible.
 await expect(f.runtime.repository.recordDatasetRevisionContentView({projectId:f.projectId,revisionId:f.sealedRevisionId,actorUserId:f.userId})).resolves.not.toThrow();
 expect((await lifecycle.getLifecycle(f.actor,version.id))!.currentEvent.state).toBe('retired');
 expect(f.db.prepare('SELECT explicit_allowed,implicit_allowed FROM evaluator_lifecycle_contexts WHERE skill_version_id=?').get(version.id)).toEqual({explicit_allowed:0,implicit_allowed:0});
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('maps a lifecycle refusal before authorization to the typed PostgreSQL error without a lease',async()=>{
 const f=await activationFixture(),version=f.candidate.skill.currentVersion,lifecycle=f.runtime.evaluatorLifecycle;
 let now=lastMs(f.db)+10;const clock=()=>now;
 const run=createCalibrationRun(f.db,f.actor,{datasetRevisionId:f.sealedRevisionId,skillVersionId:version.id,positiveClass:'fail',trialPlan:{kind:'single',trialsPerItem:1},suiteBinding:null,idempotencyKey:'second-run'},clock);
 const head=(await lifecycle.getLifecycle(f.actor,version.id))!.currentEvent;
 await lifecycle.retire(f.actor,version.id,{expectedState:head.state,expectedSequence:head.sequence,expectedEventId:head.id,expectedEventDigest:head.contentDigest,rationale:'Retire exact evaluator.',idempotencyKey:'retire:'+head.id} as never);
 now=Math.max(now,lastMs(f.db))+10;
 const claim=sqliteCalibrationClaimCommands(f.db,clock).claimRun(run.runId,'A',10000)!;
 let refusal:unknown;try{sqliteCalibrationExecutionCommands(f.db,clock).authorizeRun(claim);}catch(error){refusal=error;}
 expect(refusal).toBeInstanceOf(BinaryCalibrationRepositoryError);expect(refusal).toMatchObject({code:'ineligible'});
 // Not authorized: the recovery declines and nothing is leased or minted.
 expect(sqliteCalibrationMintCommands(f.db,clock).finalizeLifecycleForbiddenRun(claim)).toBeNull();
 expect(f.db.prepare('SELECT authorization_check_id,state FROM binary_calibration_runs WHERE id=?').get(run.runId)).toEqual({authorization_check_id:null,state:'running'});
 expect(f.db.prepare('SELECT count(*) n FROM binary_calibration_revision_leases').get()!.n).toBe(0);
});

it('leaves a run whose lifecycle still authorizes it to dispatch and mint normally',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput),counting=countingExecutor(f.version.executionBinding.provider);
 const minted=(await processBinaryCalibrationRun({repository:repository(f.db,Date.now),executeProvider:counting.execute,runId:run.runId,workerId:'A',claimTtlMs:60000}))!;
 expect(counting.dispatched).toHaveLength(minted.artifact.truth.itemCount);
 expect(minted.artifact).toMatchObject({status:'complete',incompleteReasons:[]});
});
