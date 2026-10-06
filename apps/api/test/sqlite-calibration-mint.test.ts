import {expect,it} from 'vitest';
import {DatabaseSync,backup} from 'node:sqlite';
import {join,dirname} from 'node:path';
import {openSqlite} from '@rubrist/db/sqlite';
import {calibrationFixture} from './helpers/sqlite-calibration.js';
import {createCalibrationRun} from '../src/storage/sqlite/calibration-run-commands.js';
import {sqliteCalibrationClaimCommands} from '../src/storage/sqlite/calibration-claim-commands.js';
import {sqliteCalibrationExecutionCommands} from '../src/storage/sqlite/calibration-execution-commands.js';
import {sqliteCalibrationMintCommands} from '../src/storage/sqlite/calibration-mint-commands.js';
import {sqliteCommands} from '../src/storage/sqlite/commands.js';
import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
import {verifyBinaryCalibrationPrivateLedgerForArtifact} from '../src/lib/binary-calibration.js';
async function accounted(recovered=false){
 const f=await calibrationFixture(),run=createCalibrationRun(f.db,f.actor,f.calibrationInput),claim=sqliteCalibrationClaimCommands(f.db).claimRun(run.runId,'worker',10000)!,execution=sqliteCalibrationExecutionCommands(f.db);
 execution.authorizeRun(claim);const item=execution.getNextAttempt(claim)!;execution.recordProviderCallStarted(claim,item.attemptId);
 if(recovered)execution.recoverStartedAttempts(claim);else execution.completeAttempt(claim,item.attemptId,{result:{state:'outcome',outcome:'pass'},attemptState:'terminal',providerObservation:{provider:f.version.executionBinding.provider,observedModel:f.version.executionBinding.modelId,observedVersion:null,systemFingerprint:null,upstreamProvider:null}});
 return {...f,run,claim};
}
it('atomically mints exact public/private evidence and retains bytes across restart and backup',async()=>{
 const f=await accounted(),mint=sqliteCalibrationMintCommands(f.db),result=mint.finalizeRun(f.claim);
 expect(result.run.state).toBe(result.artifact.status);expect(result.artifact.truth.datasetRevisionId).toBe(f.revisionId);expect(result.run.accountedObservations).toBe(1);
 expect(f.db.prepare('SELECT * FROM binary_calibration_revision_leases').all()).toEqual([]);
 const ledger=JSON.parse(Buffer.from(f.db.prepare('SELECT canonical_bytes FROM binary_calibration_private_ledgers WHERE run_id=?').get(f.run.runId)!.canonical_bytes as Uint8Array).toString('utf8'));
 expect(()=>verifyBinaryCalibrationPrivateLedgerForArtifact(ledger,result.artifact)).not.toThrow();
 expect(mint.getArtifact(f.actor,result.artifact.artifactId)).toEqual(result.artifactCopy);
 expect(mint.getArtifactStatus(f.actor,result.artifact.artifactId).currentAdmissibility).toBe('admissible');
 const restarted=openSqlite(f.path);try{sqliteCommands(restarted);expect(sqliteCalibrationMintCommands(restarted).getArtifact(f.actor,result.artifact.artifactId)).toEqual(result.artifactCopy);}finally{restarted.close();}
 const path=join(dirname(f.path),'backup.sqlite');await backup(f.db,path);const copy=new DatabaseSync(path);try{expect(Buffer.from(copy.prepare('SELECT canonical_bytes FROM binary_calibration_artifacts WHERE id=?').get(result.artifact.artifactId)!.canonical_bytes as Uint8Array)).toEqual(Buffer.from(result.artifactCopy.canonicalBytes));expect(copy.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');}finally{copy.close();}
 expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT * FROM binary_calibration_artifacts').all()).toEqual([]);
});
it('retains incomplete evidence for an unknown interrupted outcome',async()=>{
 const f=await accounted(true),result=sqliteCalibrationMintCommands(f.db).finalizeRun(f.claim);expect(result.artifact.status).toBe('incomplete');expect(result.run.state).toBe('incomplete');
 expect(f.db.prepare('SELECT error_code FROM binary_calibration_attempts').get()?.error_code).toBe('outcome_unknown');
});
it('rolls back artifact, private ledger, completion checks and lease release on finalizer failure',async()=>{
 const f=await accounted(),mint=sqliteCalibrationMintCommands(f.db);f.db.exec("CREATE TRIGGER test_mint_failure BEFORE INSERT ON binary_calibration_mint_finalizations BEGIN SELECT RAISE(ABORT,'injected mint failure'); END;");
 expect(()=>mint.finalizeRun(f.claim)).toThrow(/injected mint failure/);
 for(const table of ['binary_calibration_artifacts','binary_calibration_private_ledgers','binary_calibration_mint_claims'])expect(f.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
 expect(f.db.prepare("SELECT * FROM binary_calibration_exposure_checks WHERE phase='completion'").all()).toEqual([]);expect(f.db.prepare('SELECT run_id FROM binary_calibration_revision_leases').get()?.run_id).toBe(f.run.runId);
 f.db.exec('DROP TRIGGER test_mint_failure');expect(mint.finalizeRun(f.claim).artifactCopy.canonicalBytes.byteLength).toBeGreaterThan(0);
});
it('derives current revocation without altering immutable artifacts',async()=>{
 const f=await accounted(),mint=sqliteCalibrationMintCommands(f.db),result=mint.finalizeRun(f.claim),before=mint.getArtifact(f.actor,result.artifact.artifactId);
 sqliteCommand(f.db,c=>c.db.prepare('INSERT INTO binary_calibration_revocation_events VALUES(?,?,?,?,?,?,?,?)').run('revocation',result.artifact.artifactId,f.run.runId,f.projectId,'provider_policy_invalidated','synthetic_fixture','policy',c.timestamp));
 expect(mint.getArtifactStatus(f.actor,result.artifact.artifactId)).toMatchObject({currentAdmissibility:'revoked',reasons:['provider_policy_invalidated']});expect(mint.getArtifact(f.actor,result.artifact.artifactId)).toEqual(before);
 await f.runtime.repository.recordDatasetRevisionContentView({projectId:f.projectId,revisionId:f.revisionId,actorUserId:f.userId});
 expect(mint.getArtifactStatus(f.actor,result.artifact.artifactId).reasons).toEqual(['development_exposure','provider_policy_invalidated']);
 expect(()=>mint.getArtifact({projectId:'other'},result.artifact.artifactId)).toThrow(expect.objectContaining({code:'not_found'}));
});
import type {SQLInputValue} from 'node:sqlite';
import {canonicalJson} from '../src/lib/canonical-json.js';
import {binaryCalibrationArtifactDigest} from '../src/lib/binary-calibration.js';
it('rejects a forged public BLOB even when the attacker recomputes its byte digest',async()=>{
 const f=await accounted(),now=Date.now()+1000,mint=sqliteCalibrationMintCommands(f.db,()=>now),captured=new Map<string,Record<string,SQLInputValue>>();
 const tables=['binary_calibration_exposure_checks','binary_calibration_private_ledgers','binary_calibration_artifacts'];
 f.db.function('test_capture_mint',(table,id)=>{captured.set(String(table),{...f.db.prepare(`SELECT * FROM ${String(table)} WHERE id=?`).get(id)!});return 0;});
 for(const table of tables)f.db.exec(`CREATE TRIGGER capture_${table} AFTER INSERT ON ${table} BEGIN SELECT test_capture_mint('${table}',NEW.id); END;`);
 f.db.exec("CREATE TRIGGER test_mint_failure BEFORE INSERT ON binary_calibration_mint_finalizations BEGIN SELECT RAISE(ABORT,'capture and rollback'); END;");
 expect(()=>mint.finalizeRun(f.claim)).toThrow(/capture and rollback/);
 f.db.exec('DROP TRIGGER test_mint_failure');for(const table of tables)f.db.exec(`DROP TRIGGER capture_${table}`);
 const root=captured.get('binary_calibration_artifacts')!;
 expect(()=>sqliteCommand(f.db,c=>{const row={...root,artifact_revision:2,predecessor_artifact_id:'prior',correction_reason:'Forged revision'};c.db.prepare(`INSERT INTO binary_calibration_artifacts(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));},()=>now)).toThrow(/root artifact lineage/);
 const artifact=captured.get('binary_calibration_artifacts')!,parsed=JSON.parse(Buffer.from(artifact.canonical_bytes as Uint8Array).toString('utf8'));
 parsed.evaluator.skillId='forged-evaluator';artifact.canonical_bytes=Buffer.from(canonicalJson(parsed));artifact.artifact_digest=binaryCalibrationArtifactDigest(artifact.canonical_bytes as Uint8Array);
 const replay=()=>sqliteCommand(f.db,c=>{
  c.db.prepare('INSERT INTO binary_calibration_mint_claims VALUES(?,?,?)').run(f.run.runId,f.projectId,c.token);
  for(const table of tables){const row=captured.get(table)!;c.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?')})`).run(...Object.values(row));}
  c.db.prepare("UPDATE binary_calibration_runs SET state=?,completion_check_id=?,artifact_id=?,artifact_digest=?,evidence_digest=?,completed_at=?,claim_worker_id=NULL,claim_token=NULL,claim_expires_at=NULL WHERE id=?").run(artifact.status!,captured.get('binary_calibration_exposure_checks')!.id!,artifact.id!,artifact.artifact_digest!,artifact.evidence_digest!,c.timestamp,f.run.runId);
  c.db.prepare('DELETE FROM binary_calibration_revision_leases WHERE run_id=?').run(f.run.runId);
  c.db.prepare('INSERT INTO binary_calibration_mint_finalizations VALUES(?,?,?)').run(f.run.runId,f.projectId,c.token);
 },()=>now);
 expect(replay).toThrow(/mint must match retained execution/);

 // Restore authentic public bytes, but substitute the retained completion ID.
 parsed.evaluator.skillId=f.version.skillId;artifact.canonical_bytes=Buffer.from(canonicalJson(parsed));artifact.artifact_digest=binaryCalibrationArtifactDigest(artifact.canonical_bytes as Uint8Array);
 captured.get('binary_calibration_exposure_checks')!.id='substituted-completion';
 expect(replay).toThrow(/mint must match retained execution/);
 expect(f.db.prepare('SELECT * FROM binary_calibration_artifacts').all()).toEqual([]);expect(f.db.prepare('SELECT run_id FROM binary_calibration_revision_leases').get()?.run_id).toBe(f.run.runId);
});
