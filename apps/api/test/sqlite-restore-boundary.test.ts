import {it,expect} from 'vitest';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openSqlite,migrateSqlite} from '@rubrist/db/sqlite';
import {activationFixture} from './helpers/sqlite-lifecycle-activation.js';
import {cleanup} from './helpers/sqlite-analysis.js';
import {createUnseededSqliteRuntime} from './helpers/sqlite.js';
import {sqliteCommands} from '../src/storage/sqlite/commands.js';
import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
import {transitionLifecycle} from '../src/storage/sqlite/lifecycle-transition.js';
// @ts-expect-error Operational Node CLI is intentionally JavaScript.
import {createRecoveryRecord,createBackup,restoreBackup} from '../../../tools/storage/sqlite-backup.mjs';

it('restores calibration bytes, encrypted credentials and enforced immutable/finalization boundaries',async()=>{
 const f=await activationFixture(),directory=dirname(f.path),record=join(directory,'recovery.json'),output=join(directory,'snapshot'),target=join(directory,'restored.sqlite');
 await f.runtime.repository.setJudgeProviderKey(f.projectId,'openai','synthetic-provider-key-never-dispatched',f.userId);
 createRecoveryRecord(record);
 await createBackup({source:f.path,output,recoveryFile:record});
 await restoreBackup({backupDirectory:output,target,recoveryFile:record});
 const plain=new DatabaseSync(target);try{
  expect(plain.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  expect(plain.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(()=>plain.exec('INSERT INTO binary_calibration_artifacts SELECT * FROM binary_calibration_artifacts LIMIT 1')).toThrow(/function|authorized|command/i);
 }finally{plain.close();}
 const db=openSqlite(target);cleanup.push(()=>db.close());migrateSqlite(db);sqliteCommands(db);
 const restored=await createUnseededSqliteRuntime(target);cleanup.push(()=>restored.close());
 expect(Buffer.from((await restored.binaryCalibration.getArtifact(f.actor,f.calibration.artifact.artifactId)).canonicalBytes)).toEqual(Buffer.from(f.calibration.artifactCopy.canonicalBytes));
 expect(await restored.repository.getJudgeProviderCredential(f.projectId,'openai')).toBe('synthetic-provider-key-never-dispatched');
 expect(()=>sqliteCommand(db,c=>c.db.prepare('UPDATE binary_calibration_artifacts SET canonical_bytes=? WHERE id=?').run(Buffer.from('forged'),f.calibration.artifact.artifactId))).toThrow(/immutable/);
 db.exec("CREATE TEMP TRIGGER omit_finalization BEFORE INSERT ON evaluator_activation_finalizations BEGIN SELECT RAISE(IGNORE); END;");
 expect(()=>transitionLifecycle(db,f.actor,f.candidate.skill.currentVersion.id,f.activation,'activated')).toThrow(/FOREIGN KEY|finaliz/);
 expect(db.prepare('SELECT * FROM evaluator_activation_claims').all()).toEqual([]);
 db.exec('DROP TRIGGER omit_finalization');
 expect(transitionLifecycle(db,f.actor,f.candidate.skill.currentVersion.id,f.activation,'activated').projection.currentEvent.state).toBe('active');
 expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
