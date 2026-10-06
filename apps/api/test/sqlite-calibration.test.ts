import {expect,it} from 'vitest';
import {calibrationFixture} from './helpers/sqlite-calibration.js';
import {createCalibrationRun} from '../src/storage/sqlite/calibration-run-commands.js';
it('pins a queued calibration to governed sealed truth without dispatching a provider',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput);
 expect(run).toMatchObject({datasetRevisionId:f.revisionId,skillVersionId:f.version.id,state:'queued',plannedObservations:1,accountedObservations:0,artifactId:null});
 expect(createCalibrationRun(f.db,f.actor,f.calibrationInput)).toEqual(run);
 expect(f.db.prepare('SELECT * FROM binary_calibration_attempts').all()).toEqual([]);
 expect(()=>createCalibrationRun(f.db,f.actor,{...f.calibrationInput,positiveClass:'pass'})).toThrow(expect.objectContaining({code:'idempotency_conflict'}));
 expect(()=>createCalibrationRun(f.db,f.actor,{...f.calibrationInput,idempotencyKey:'competing'})).toThrow(expect.objectContaining({code:'state_conflict'}));
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('requires live project ownership and exact sealed truth',async()=>{
 const f=await calibrationFixture();
 expect(()=>createCalibrationRun(f.db,{...f.actor,userId:f.reviewers[0]!},f.calibrationInput)).toThrow(expect.objectContaining({code:'forbidden'}));
 expect(()=>createCalibrationRun(f.db,f.actor,{...f.calibrationInput,datasetRevisionId:f.revision.id})).toThrow(expect.objectContaining({code:'ineligible'}));
 expect(f.db.prepare('SELECT * FROM binary_calibration_runs').all()).toEqual([]);
});

import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
import type {SQLInputValue} from 'node:sqlite';
it('enforces the native database lineage, byte digest and staged execution boundaries',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput);
 const original=f.db.prepare('SELECT * FROM binary_calibration_runs WHERE id=?').get(run.runId)!;
 const insert=(overrides:Record<string,SQLInputValue>)=>sqliteCommand(f.db,c=>{const row={...original,id:'forged',idempotency_key:'forged',created_at:c.timestamp,...overrides};c.db.prepare(`INSERT INTO binary_calibration_runs(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));});
 expect(()=>insert({truth_content_digest:'sha256:'+'0'.repeat(64)})).toThrow(/exact governed sealed evaluator lineage/);
 expect(()=>insert({provider_policy_canonical_bytes:Buffer.from('{}')})).toThrow(/provider policy byte digest/);
 expect(()=>insert({governed_review_batch_digest:'sha256:'+'0'.repeat(64)})).toThrow(/exact frozen batch origin/);
 expect(()=>insert({state:'running'})).toThrow(/fresh queued command/);
 for(const field of ['artifact_digest','evidence_digest','rejection_reason'])expect(()=>insert({[field]:'sha256:'+'0'.repeat(64)})).toThrow(/fresh queued command/);
 const reordered=JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(String(original.execution_binding))).reverse()));
 // Semantic equality reaches the later active-run uniqueness check.
 expect(()=>insert({execution_binding:reordered})).toThrow(/UNIQUE constraint failed: binary_calibration_runs.dataset_revision_id, binary_calibration_runs.skill_version_id/);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare("UPDATE binary_calibration_runs SET started_at='2026-10-06T00:00:00.000Z' WHERE id=?").run(run.runId))).toThrow(/calibration authorization/);
 expect(()=>f.db.prepare('DELETE FROM binary_calibration_runs WHERE id=?').run(run.runId)).toThrow(/project erasure/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM binary_calibration_runs').all()).toEqual([]);
});
it('pins the exact immutable single-trial suite member',async()=>{
 const f=await calibrationFixture();
 const manifest=await f.runtime.repository.createEvaluatorSuiteManifest(f.projectId,{members:[{criterionVersionId:f.criterionVersionId,skillVersionId:f.version.id}],trialPlan:null,idempotencyKey:'suite'},{actorUserId:f.userId});
 const input={...f.calibrationInput,suiteBinding:{manifestId:manifest.manifestId,memberPosition:0}};
 const run=createCalibrationRun(f.db,f.actor,input);
 expect(run.suiteBinding).toEqual({...input.suiteBinding,manifestDigest:manifest.manifestDigest});
 expect(()=>createCalibrationRun(f.db,f.actor,{...input,suiteBinding:{...input.suiteBinding,memberPosition:1}})).toThrow(expect.objectContaining({code:'ineligible'}));
});
