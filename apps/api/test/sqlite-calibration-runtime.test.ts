import {expect,it,vi} from 'vitest';
import {calibrationFixture} from './helpers/sqlite-calibration.js';
import {createUnseededSqliteRuntime} from './helpers/sqlite.js';
import {cleanup} from './helpers/sqlite-analysis.js';
import {BinaryCalibrationRepositoryError} from '../src/binary-calibration/repository.js';
import {processBinaryCalibrationRun} from '../src/binary-calibration/worker.js';
import {createApp} from '../src/app.js';
it('runs native calibration through typed worker RPC with one mocked physical call',async()=>{
 const f=await calibrationFixture(),peer=await createUnseededSqliteRuntime(f.path);cleanup.push(()=>peer.close());
 const [run,replay]=await Promise.all([f.runtime.binaryCalibration.createRun(f.actor,f.calibrationInput),peer.binaryCalibration.createRun(f.actor,f.calibrationInput)]);expect(replay).toEqual(run);
 await expect(peer.binaryCalibration.createRun({...f.actor,userId:f.reviewers[0]!},f.calibrationInput)).rejects.toBeInstanceOf(BinaryCalibrationRepositoryError);
 let calls=0;const result=await processBinaryCalibrationRun({repository:peer.binaryCalibrationExecution,runId:run.runId,workerId:'synthetic-worker',recheck:async()=>({outcome:'holds',probes:[]}),executeProvider:async({authorizedRun,attempt,beforePhysicalCall})=>{expect(attempt.payloadSnapshot).toMatchObject({input:expect.any(String)});await beforePhysicalCall();calls++;return {outcome:'pass',providerObservation:{provider:authorizedRun.executionBinding.provider,observedModel:authorizedRun.executionBinding.modelId,observedVersion:null,systemFingerprint:null,upstreamProvider:null}};}});
 expect(calls).toBe(1);expect(result?.artifactCopy.canonicalBytes).toBeInstanceOf(Buffer);
 expect(await f.runtime.binaryCalibration.getArtifact(f.actor,result!.artifact.artifactId)).toEqual(result!.artifactCopy);
 expect(Object.keys(f.runtime.binaryCalibration)).not.toContain('getNextAttempt');expect(Object.keys(f.runtime.binaryCalibration)).not.toContain('finalizeRun');
 await peer.close();const restarted=await createUnseededSqliteRuntime(f.path);cleanup.push(()=>restarted.close());expect(await restarted.binaryCalibration.getArtifact(f.actor,result!.artifact.artifactId)).toEqual(result!.artifactCopy);
 await expect(restarted.binaryCalibration.getRun({projectId:'foreign'},run.runId)).rejects.toMatchObject({code:'not_found'});
});
it('serves owner-only immutable HTTP artifacts while keeping protected data out of responses',async()=>{
 const f=await calibrationFixture(),app=createApp(f.runtime.repository,{auth:f.runtime.auth,accounts:f.runtime.accounts,runtimeMode:'persistent',binaryCalibrationRepository:f.runtime.binaryCalibration});
 const login=async(email:string)=>{const response=await app.request('/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'synthetic-long-password'})});expect(response.status).toBe(200);return {cookie:response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),'content-type':'application/json'};};
 const headers=await login('owner@example.test');expect((await app.request('/api/binary-calibration-runs')).status).toBe(401);
 const created=await app.request('/api/binary-calibration-runs',{method:'POST',headers,body:JSON.stringify(f.calibrationInput)});expect(created.status).toBe(202);expect(created.headers.get('cache-control')).toBe('no-store');const {run}=await created.json() as {run:{runId:string}};
 const result=await processBinaryCalibrationRun({repository:f.runtime.binaryCalibrationExecution,runId:run.runId,workerId:'http-fixture',executeProvider:async({authorizedRun,beforePhysicalCall})=>{await beforePhysicalCall();return {outcome:'pass',providerObservation:{provider:authorizedRun.executionBinding.provider,observedModel:null,observedVersion:null,systemFingerprint:null,upstreamProvider:null}};}});
 const path='/api/v1/binary-calibration-artifacts/'+result!.artifact.artifactId,response=await app.request(path,{headers});expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(result!.artifactCopy.canonicalBytes));
 expect((await app.request(path+'/status',{headers})).status).toBe(200);
 const member=await login('reviewer0@example.test');expect((await app.request(path,{headers:member})).status).toBe(403);
 const list=await app.request('/api/binary-calibration-runs',{headers:member});expect(list.status).toBe(200);expect(await list.text()).not.toMatch(/Protected [12]|commitmentSalt|payloadSnapshot|privateLedger/);
 const conflict=await app.request('/api/binary-calibration-runs',{method:'POST',headers,body:JSON.stringify({...f.calibrationInput,positiveClass:'pass'})});expect(conflict.status).toBe(409);expect(await conflict.json()).toMatchObject({code:'binary_calibration_idempotency_conflict'});
});
it('backs off an unknown recheck without obtaining any sealed work',async()=>{
 const f=await calibrationFixture(),run=await f.runtime.binaryCalibration.createRun(f.actor,f.calibrationInput),executeProvider=vi.fn();
 expect(await processBinaryCalibrationRun({repository:f.runtime.binaryCalibrationExecution,runId:run.runId,workerId:'unknown',recheck:async()=>({outcome:'unknown',probes:[]}),executeProvider})).toBeNull();
 expect(executeProvider).not.toHaveBeenCalled();expect((await f.runtime.binaryCalibration.getRun(f.actor,run.runId)).state).toBe('recovery_required');expect(f.db.prepare('SELECT * FROM binary_calibration_revision_leases').all()).toEqual([]);
});
