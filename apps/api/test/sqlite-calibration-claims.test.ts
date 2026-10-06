import {expect,it} from 'vitest';
import {openSqlite} from '@rubrist/db/sqlite';
import {calibrationFixture} from './helpers/sqlite-calibration.js';
import {createCalibrationRun} from '../src/storage/sqlite/calibration-run-commands.js';
import {sqliteCalibrationClaimCommands} from '../src/storage/sqlite/calibration-claim-commands.js';
import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
it('fences claim takeover across connections and a backwards host clock',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput);
 let now=Date.now()+10000;const first=sqliteCalibrationClaimCommands(f.db,()=>now),db2=openSqlite(f.path);
 try{const second=sqliteCalibrationClaimCommands(db2,()=>now),claim=first.claimRun(run.runId,'worker-a',1000)!;
  expect(claim.claimExpiresAt).toBe(new Date(now+1000).toISOString());expect(second.claimRun(run.runId,'worker-b',1000)).toBeNull();
  now-=5000;expect(second.claimRun(run.runId,'worker-b',1000)).toBeNull();
  const heartbeat=first.heartbeatClaim(claim,2000);expect(heartbeat.claimToken).toBe(claim.claimToken);expect(heartbeat.claimExpiresAt).toBe(new Date(now+7000).toISOString());
  now+=7000;expect(second.claimRun(run.runId,'worker-b',1000)).toBeNull();now++;
  expect(first.listRunnableRunIds(10)).toEqual([run.runId]);const takeover=second.claimRun(run.runId,'worker-b',1000)!;expect(takeover.claimToken).not.toBe(claim.claimToken);
  expect(()=>first.heartbeatClaim(claim,1000)).toThrow(expect.objectContaining({code:'state_conflict'}));
  expect(()=>first.rejectBeforeAuthorization(claim,'resolution_no_longer_holds')).toThrow(expect.objectContaining({code:'state_conflict'}));
  second.markRecoveryRequired(takeover);expect(first.getRun(f.actor,run.runId).state).toBe('recovery_required');expect(first.claimRun(run.runId,'worker-c',1000)).not.toBeNull();
 }finally{db2.close();}
});
it('persists a rejected recheck and never discovers or reclaims terminal runs',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput);let now=Date.now()+10000;const commands=sqliteCalibrationClaimCommands(f.db,()=>now),claim=commands.claimRun(run.runId,'worker',1000)!;
 const target=commands.getRecheckTarget(claim);expect(target.authorized).toBe(false);expect(target.binding.executionBinding).toEqual(f.version.executionBinding);
 commands.recordRecheck(claim,{outcome:'unknown',probes:[]});now+=100;expect(commands.getRecheckTarget(claim).msSinceUnknownRecheck).toBe(100);
 commands.recordRecheck(claim,{outcome:'no_longer_holds',probes:[]});commands.rejectBeforeAuthorization(claim,'resolution_no_longer_holds');
 expect(commands.getRun(f.actor,run.runId)).toMatchObject({state:'rejected',completedAt:new Date(now).toISOString()});expect(commands.listRunnableRunIds(10)).toEqual([]);expect(commands.claimRun(run.runId,'other',1000)).toBeNull();
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare("UPDATE binary_calibration_runs SET state='queued',completed_at=NULL WHERE id=?").run(run.runId))).toThrow(/immutable terminal/);
 expect(commands.listRuns({projectId:'other'})).toEqual([]);expect(()=>commands.getRun({projectId:'other'},run.runId)).toThrow(expect.objectContaining({code:'not_found'}));
});
it('protects pinned identities and requires fixed canonical claim timestamps',async()=>{
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput),commands=sqliteCalibrationClaimCommands(f.db),claim=commands.claimRun(run.runId,'worker',10000)!;
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare("UPDATE binary_calibration_runs SET positive_class='pass' WHERE id=?").run(run.runId))).toThrow(/immutable calibration pinned identity/);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare("UPDATE binary_calibration_runs SET claim_expires_at='9999-01-01 00:00:00' WHERE id=?").run(run.runId))).toThrow(/invalid calibration claim expiry/);
 expect(()=>commands.claimRun(run.runId,'',1000)).toThrow();expect(()=>commands.listRunnableRunIds(0)).toThrow();expect(()=>commands.heartbeatClaim(claim,0)).toThrow();
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
