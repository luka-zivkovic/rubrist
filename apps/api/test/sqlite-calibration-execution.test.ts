import {expect,it} from 'vitest';
import {openSqlite} from '@rubrist/db/sqlite';
import {calibrationFixture} from './helpers/sqlite-calibration.js';
import {createCalibrationRun} from '../src/storage/sqlite/calibration-run-commands.js';
import {sqliteCalibrationClaimCommands} from '../src/storage/sqlite/calibration-claim-commands.js';
import {sqliteCalibrationExecutionCommands} from '../src/storage/sqlite/calibration-execution-commands.js';
import {sqliteCommands} from '../src/storage/sqlite/commands.js';
import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
it('authorizes an exact sealed bundle and persists a started call before crash recovery',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput),claims=sqliteCalibrationClaimCommands(f.db),claim=claims.claimRun(run.runId,'worker',10000)!,execution=sqliteCalibrationExecutionCommands(f.db);
 const auth=execution.authorizeRun(claim);expect(auth.executionBinding).toEqual(f.version.executionBinding);expect(execution.authorizeRun(claim)).toEqual(auth);
 expect(f.db.prepare("SELECT count(*) n FROM governed_review_capability_checks WHERE check_scope='final_validation' AND result='eligible'").get()?.n).toBe(3);
 expect(f.db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(2);
 const work=execution.getNextAttempt(claim)!;expect(work.payloadSnapshot).toMatchObject({input:expect.any(String)});expect(execution.recordProviderCallStarted(claim,work.attemptId)).toBe(1);
 const db2=openSqlite(f.path);try{sqliteCommands(db2);const resumed=sqliteCalibrationExecutionCommands(db2);expect(resumed.getNextAttempt(claim)).toBeNull();expect(resumed.recoverStartedAttempts(claim)).toBe(1);expect(resumed.recoverStartedAttempts(claim)).toBe(0);expect(resumed.getNextAttempt(claim)).toBeNull();}finally{db2.close();}
 expect(claims.getRun(f.actor,run.runId).accountedObservations).toBe(1);expect(f.db.prepare('SELECT terminal_evaluator_outcome,error_code,physical_provider_calls FROM binary_calibration_attempts').get()).toEqual({terminal_evaluator_outcome:'errored',error_code:'outcome_unknown',physical_provider_calls:1});
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('commits failed separation checks and rejection without authorizing or revealing payloads',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput);
 await f.runtime.repository.recordDatasetRevisionContentView({projectId:f.projectId,revisionId:f.revision.id,actorUserId:f.reviewers[0]!});
 const claims=sqliteCalibrationClaimCommands(f.db),claim=claims.claimRun(run.runId,'worker',10000)!,execution=sqliteCalibrationExecutionCommands(f.db);
 expect(()=>execution.authorizeRun(claim)).toThrow(expect.objectContaining({code:'ineligible'}));expect(claims.getRun(f.actor,run.runId).state).toBe('rejected');
 expect(f.db.prepare("SELECT count(*) n FROM governed_review_capability_checks WHERE check_scope='final_validation' AND result='ineligible'").get()?.n).toBe(1);
 expect(f.db.prepare('SELECT * FROM binary_calibration_revision_leases').all()).toEqual([]);expect(f.db.prepare('SELECT * FROM binary_calibration_attempts').all()).toEqual([]);expect(f.db.prepare('SELECT * FROM binary_calibration_exposure_checks').all()).toEqual([]);
});
it('rolls back every authorization write when bundle finalization fails',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput),claim=sqliteCalibrationClaimCommands(f.db).claimRun(run.runId,'worker',10000)!;
 f.db.exec("CREATE TRIGGER test_calibration_failure BEFORE INSERT ON binary_calibration_authorization_finalizations BEGIN SELECT RAISE(ABORT,'injected finalizer failure'); END;");
 expect(()=>sqliteCalibrationExecutionCommands(f.db).authorizeRun(claim)).toThrow(/injected finalizer failure/);
 for(const table of ['binary_calibration_revision_leases','binary_calibration_attempts','binary_calibration_exposure_checks','binary_calibration_authorization_claims'])expect(f.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
 expect(f.db.prepare("SELECT * FROM governed_review_capability_checks WHERE check_scope='final_validation'").all()).toEqual([]);
 expect(f.db.prepare('SELECT authorization_check_id FROM binary_calibration_runs WHERE id=?').get(run.runId)?.authorization_check_id).toBeNull();
});
it('blocks development exposure throughout an active calibration lease',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput),claim=sqliteCalibrationClaimCommands(f.db).claimRun(run.runId,'worker',10000)!;
 sqliteCalibrationExecutionCommands(f.db).authorizeRun(claim);
 await expect(f.runtime.repository.recordDatasetRevisionContentView({projectId:f.projectId,revisionId:f.revisionId,actorUserId:f.userId})).rejects.toThrow(/active sealed calibration lease/);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare('DELETE FROM binary_calibration_revision_leases WHERE run_id=?').run(run.runId))).toThrow(/project erasure/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT * FROM binary_calibration_attempts').all()).toEqual([]);
});
it('accounts each observation once and preserves provider identity constraints',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput),claim=sqliteCalibrationClaimCommands(f.db).claimRun(run.runId,'worker',10000)!,execution=sqliteCalibrationExecutionCommands(f.db);
 execution.authorizeRun(claim);const work=execution.getNextAttempt(claim)!;execution.recordProviderCallStarted(claim,work.attemptId);
 const input={result:{state:'outcome' as const,outcome:'pass' as const},attemptState:'terminal' as const,providerObservation:{provider:f.version.executionBinding.provider,observedModel:f.version.executionBinding.modelId,observedVersion:null,systemFingerprint:null,upstreamProvider:null}};
 expect(()=>execution.completeAttempt(claim,work.attemptId,{...input,providerObservation:{...input.providerObservation,provider:'mock'}})).toThrow(expect.objectContaining({code:'conflict'}));
 execution.completeAttempt(claim,work.attemptId,input);
 expect(()=>execution.completeAttempt(claim,work.attemptId,input)).toThrow(expect.objectContaining({code:'state_conflict'}));
 expect(()=>execution.recordProviderCallStarted(claim,work.attemptId)).toThrow(expect.objectContaining({code:'state_conflict'}));
 expect(f.db.prepare('SELECT accounted_observations FROM binary_calibration_runs WHERE id=?').get(run.runId)?.accounted_observations).toBe(1);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare("UPDATE binary_calibration_attempts SET physical_provider_calls=2 WHERE id=?").run(work.attemptId))).toThrow(/immutable accounted/);
});
import {CreateSkillVersionInputSchema} from '@rubrist/shared';
import {sqliteSkillCommands} from '../src/storage/sqlite/skill-commands.js';
import {sqliteResolutionStore} from '../src/storage/sqlite/resolution-commands.js';
import {bindingInput,resolvedRecordFor} from './fixtures/execution-binding.js';
it('serializes authorization of competing evaluators on the same sealed revision',async()=>{
 const f=await calibrationFixture(),other=sqliteSkillCommands(f.db).insertPendingSkillVersion(f.version.skillId,CreateSkillVersionInputSchema.parse({criterionVersionId:f.criterionVersionId,rubricMarkdown:'Other review guide',prompt:'Evaluate the response',verdictKind:'binary',executionBinding:bindingInput(f.version.executionBinding)}),{projectId:f.projectId,actorUserId:f.userId});
 const resolution=await resolvedRecordFor(other.executionBinding);sqliteCommand(f.db,()=>sqliteResolutionStore(f.db).save(f.projectId,other.id,other.executionBinding,resolution));
 const run=createCalibrationRun(f.db,f.actor,f.calibrationInput),competitor=createCalibrationRun(f.db,f.actor,{...f.calibrationInput,skillVersionId:other.id,idempotencyKey:'competitor'}),claims=sqliteCalibrationClaimCommands(f.db),first=claims.claimRun(run.runId,'first',10000)!,second=claims.claimRun(competitor.runId,'second',10000)!,execution=sqliteCalibrationExecutionCommands(f.db);
 execution.authorizeRun(first);expect(()=>execution.authorizeRun(second)).toThrow(expect.objectContaining({code:'state_conflict'}));
 expect(f.db.prepare('SELECT run_id FROM binary_calibration_revision_leases').all()).toEqual([{run_id:run.runId}]);
 expect(f.db.prepare('SELECT * FROM binary_calibration_attempts WHERE run_id=?').all(competitor.runId)).toEqual([]);
 expect(f.db.prepare("SELECT * FROM governed_review_capability_checks WHERE check_scope='final_validation' AND evaluator_version_id=?").all(other.id)).toEqual([]);
});
it.each(['identity','calls','state','upstream'])('rejects direct calibration attempt %s violations before accounting',async field=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput),claim=sqliteCalibrationClaimCommands(f.db).claimRun(run.runId,'worker',10000)!,execution=sqliteCalibrationExecutionCommands(f.db);
 execution.authorizeRun(claim);const work=execution.getNextAttempt(claim)!;execution.recordProviderCallStarted(claim,work.attemptId);
 const set={identity:"dataset_revision_item_digest='sha256:'||printf('%064d',0)",calls:'physical_provider_calls=0',state:"attempt_state='not_started'",upstream:"upstream_provider='unexpected'"}[field]!;
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare(`UPDATE binary_calibration_attempts SET ${set} WHERE id=?`).run(work.attemptId))).toThrow(field==='identity'?/immutable calibration attempt identity/:field==='upstream'?/upstream provider requires OpenRouter/:/state and calls are monotonic/);
 expect(f.db.prepare('SELECT accounting_state,attempt_state,physical_provider_calls,upstream_provider FROM binary_calibration_attempts WHERE id=?').get(work.attemptId)).toEqual({accounting_state:'pending',attempt_state:'started',physical_provider_calls:1,upstream_provider:null});
});
it('refuses to reject an authorized run, whose lease only a terminal mint can release',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput),claim=sqliteCalibrationClaimCommands(f.db).claimRun(run.runId,'worker',10000)!;
 sqliteCalibrationExecutionCommands(f.db).authorizeRun(claim);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare("UPDATE binary_calibration_runs SET state='rejected',rejection_reason='x',completed_at=?,claim_worker_id=NULL,claim_token=NULL,claim_expires_at=NULL WHERE id=?").run(c.timestamp,run.runId))).toThrow(/authorized calibration run cannot be rejected/);
 expect(f.db.prepare('SELECT state,authorization_check_id IS NOT NULL authorized FROM binary_calibration_runs WHERE id=?').get(run.runId)).toEqual({state:'running',authorized:1});
 expect(f.db.prepare('SELECT run_id FROM binary_calibration_revision_leases').all()).toEqual([{run_id:run.runId}]);
 expect(()=>sqliteCalibrationClaimCommands(f.db).rejectBeforeAuthorization(claim,'resolution_no_longer_holds')).toThrow(expect.objectContaining({code:'state_conflict'}));
});
