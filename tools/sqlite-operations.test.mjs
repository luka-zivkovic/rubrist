import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,existsSync,chmodSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {migrateSqlite,openSqlite} from '../packages/db/dist/sqlite.js';
import {createBackup,restoreBackup,createRecoveryRecord,writeRecoveryEnv} from './storage/sqlite-backup.mjs';
import {prepareInstallation} from './self-host/install.mjs';

const secret='synthetic-operations-secret-never-use-in-deployment';
test('online WAL snapshot restores exact bytes without overwriting files; verifies secret, checksum and schema',async()=>{
  const root=mkdtempSync(join(tmpdir(),'rubrist-backup-'));
  const source=join(root,'live.sqlite'),recovery=join(root,'recovery.json'),output=join(root,'backup');
  const db=openSqlite(source);migrateSqlite(db);
  try{
    createRecoveryRecord(recovery,secret);
    db.exec('PRAGMA wal_autocheckpoint=0;CREATE TABLE backup_fixture (id INTEGER PRIMARY KEY, evidence BLOB NOT NULL) STRICT');
    const bytes=Buffer.from([0,255,1,13,10,128]);db.prepare('INSERT INTO backup_fixture VALUES(1,?)').run(bytes);
    assert.ok(statSync(source+'-wal').size>0);
    const manifest=await createBackup({source,output,recoveryFile:recovery,secret});
    assert.equal(manifest.history.length,65);
    assert.equal(statSync(join(output,'database.sqlite')).mode&0o777,0o600);
    assert.equal(existsSync(join(output,'database.sqlite-wal')),false);
    assert.equal(JSON.stringify(manifest).includes(secret),false);
    db.prepare('INSERT INTO backup_fixture VALUES(2,?)').run(Buffer.from('later'));
    const target=join(root,'restored.sqlite');
    await restoreBackup({secret,backupDirectory:output,target,recoveryFile:recovery});
    assert.equal(statSync(target).mode&0o777,0o600);
    const restored=new DatabaseSync(target);try{assert.deepEqual(restored.prepare('SELECT * FROM backup_fixture').all().map(row=>({id:row.id,evidence:Buffer.from(row.evidence)})),[{id:1,evidence:bytes}]);}finally{restored.close();}
    await assert.rejects(restoreBackup({secret,backupDirectory:output,target,recoveryFile:recovery}),/new database path/);
    await assert.rejects(createBackup({source,output,recoveryFile:recovery,secret}),{code:'EEXIST'});
    await assert.rejects(restoreBackup({secret:'wrong-target-secret',backupDirectory:output,target:join(root,'wrong-target.sqlite'),recoveryFile:recovery}),/does not match/);
    const other=join(root,'other.json');createRecoveryRecord(other,'wrong-synthetic-secret');
    await assert.rejects(restoreBackup({secret,backupDirectory:output,target:join(root,'wrong.sqlite'),recoveryFile:other}),/does not match/);
    await assert.rejects(createBackup({source,output:join(root,'wrong-backup'),recoveryFile:other,secret}),/does not match/);
    assert.equal(existsSync(join(root,'wrong-backup')),false);
    const sidecar=join(root,'sidecar.sqlite');writeFileSync(sidecar+'-wal','keep');
    await assert.rejects(restoreBackup({secret,backupDirectory:output,target:sidecar,recoveryFile:recovery}),/new database path/);
    writeFileSync(join(output,'database.sqlite'),Buffer.from('corrupt'));
    await assert.rejects(restoreBackup({secret,backupDirectory:output,target:join(root,'bad.sqlite'),recoveryFile:recovery}),/checksum/);
    assert.equal(existsSync(join(root,'bad.sqlite')),false);
    writeRecoveryEnv({recoveryFile:recovery,output:join(root,'auth.env')});
    assert.equal(readFileSync(join(root,'auth.env'),'utf8'),`RUBRIST_AUTH_SECRET='${secret}'\n`);
    chmodSync(recovery,0o644);
    assert.throws(()=>writeRecoveryEnv({recoveryFile:recovery,output:join(root,'leak.env')}),/0600/);
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
test('installer provisions either fixed backend with private secrets and refuses existing directories',()=>{
  const root=mkdtempSync(join(tmpdir(),'rubrist-installer-'));
  try{
    for(const backend of ['sqlite','postgres']){
      const directory=join(root,backend);prepareInstallation({backend,version:'0.4.0',directory});
      const env=readFileSync(join(directory,'.env'),'utf8'),compose=readFileSync(join(directory,'compose.yaml'),'utf8');
      assert.equal(statSync(directory).mode&0o777,0o700);assert.equal(statSync(join(directory,'.env')).mode&0o777,0o600);
      assert.match(compose,new RegExp(`RUBRIST_STORAGE: ${backend}`));assert.match(compose,/\/ready/);
      if(backend==='sqlite'){assert.doesNotMatch(compose,/DATABASE_URL|image: postgres/);assert.doesNotMatch(env,/POSTGRES_PASSWORD/);}else{assert.match(env,/RUBRIST_POSTGRES_PASSWORD/);}
      assert.throws(()=>prepareInstallation({backend,version:'0.4.0',directory}),{code:'EEXIST'});
      assert.equal(readFileSync(join(directory,'.env'),'utf8'),env);
    }
    assert.throws(()=>prepareInstallation({backend:'sqlite',version:'latest',directory:join(root,'bad')}),/exact/);
    assert.throws(()=>prepareInstallation({backend:'sqlite',version:'0.4.0',publicUrl:'https://host/\nBAD=1',directory:join(root,'bad')}),/origin/);
    assert.equal(existsSync(join(root,'bad')),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('restore rejects valid-checksum incompatible schemas without publishing a target',async()=>{
 const root=mkdtempSync(join(tmpdir(),'rubrist-backup-schema-'));
 const source=join(root,'live.sqlite'),recoveryFile=join(root,'recovery.json');
 const db=openSqlite(source);migrateSqlite(db);createRecoveryRecord(recoveryFile,secret);
 try{
  for(const kind of ['newer','checksum','metadata']){
   const output=join(root,kind);await createBackup({source,output,recoveryFile,secret});
   const path=join(output,'database.sqlite'),copy=new DatabaseSync(path);
   try{
    if(kind==='newer')copy.prepare('INSERT INTO rubrist_sqlite_migrations VALUES(?,?,?)').run('0066_unknown.sql','0'.repeat(64),'synthetic');
    if(kind==='checksum')copy.exec("UPDATE rubrist_sqlite_migrations SET checksum='wrong' WHERE id=(SELECT min(id) FROM rubrist_sqlite_migrations)");
   }finally{copy.close();}
   const manifest=JSON.parse(readFileSync(join(output,'manifest.json'),'utf8'));
   manifest.sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
   if(kind==='metadata')manifest.history=[];
   writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest));
   const target=join(root,kind+'-restored.sqlite');
   await assert.rejects(restoreBackup({secret,backupDirectory:output,target,recoveryFile}),/schema/);
   assert.equal(existsSync(target),false);assert.equal(readdirSync(root).some(name=>name.startsWith('.rubrist-restore-')),false);
  }
  const escaped=join(root,'escaped.json');createRecoveryRecord(escaped,'synthetic-ending-backslash'+String.fromCharCode(92));
  const output=join(root,'invalid.env');assert.throws(()=>writeRecoveryEnv({recoveryFile:escaped,output}),/manual/);assert.equal(existsSync(output),false);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
