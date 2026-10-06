import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,statSync,existsSync,chmodSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {migrateSqlite,openSqlite} from '../packages/db/dist/sqlite.js';
import {createBackup,restoreBackup,createRecoveryRecord,writeRecoveryEnv} from './storage/sqlite-backup.mjs';
import {packageVersion,prepareInstallation} from './self-host/install.mjs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

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
    const migrationRoot=new URL('../packages/db/sqlite-migrations/',import.meta.url);
    assert.deepEqual(manifest.history,readdirSync(migrationRoot).filter(file=>file.endsWith('.sql')).sort().map(id=>({id,checksum:createHash('sha256').update(readFileSync(new URL(id,migrationRoot))).digest('hex')})));
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
  const version=packageVersion();
  try{
    for(const backend of ['sqlite','postgres']){
      const directory=join(root,backend);prepareInstallation({backend,version,directory});
      const env=readFileSync(join(directory,'.env'),'utf8'),compose=readFileSync(join(directory,'compose.yaml'),'utf8');
      assert.equal(statSync(directory).mode&0o777,0o700);assert.equal(statSync(join(directory,'.env')).mode&0o777,0o600);
      assert.match(compose,new RegExp(`RUBRIST_STORAGE: ${backend}`));assert.match(compose,/\/ready/);
      if(backend==='sqlite'){assert.doesNotMatch(compose,/DATABASE_URL|image: postgres/);assert.doesNotMatch(env,/POSTGRES_PASSWORD/);}else{assert.match(env,/RUBRIST_POSTGRES_PASSWORD/);}
      assert.throws(()=>prepareInstallation({backend,version,directory}),{code:'EEXIST'});
      assert.equal(readFileSync(join(directory,'.env'),'utf8'),env);
    }
    assert.throws(()=>prepareInstallation({backend:'sqlite',version:'latest',directory:join(root,'bad')}),/exact/);
    const [major,minor,patch]=version.split('.').map(Number);
    assert.throws(()=>prepareInstallation({backend:'sqlite',version:`${major}.${minor}.${patch+1}`,directory:join(root,'bad')}),/must match this installer's release/);
    assert.throws(()=>prepareInstallation({backend:'sqlite',version,publicUrl:'https://host/\nBAD=1',directory:join(root,'bad')}),/origin/);
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
    if(kind==='newer')copy.prepare('INSERT INTO rubrist_sqlite_migrations VALUES(?,?,?)').run('9999_unknown.sql','0'.repeat(64),'synthetic');
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

test('documented installer command runs from the repository root layout used by the API image',()=>{
  const repository=fileURLToPath(new URL('..',import.meta.url)),root=mkdtempSync(join(tmpdir(),'rubrist-installer-cli-'));
  try{
    // The image's WORKDIR is /repo and the docs invoke this relative path.
    const dockerfile=readFileSync(join(repository,'apps/api/Dockerfile'),'utf8'),runtime=dockerfile.slice(dockerfile.indexOf('AS runtime'));
    for(const copied of ['package.json','packages ./packages','tools/storage ./tools/storage','tools/self-host ./tools/self-host','deploy/self-host ./deploy/self-host'])assert.ok(runtime.includes(copied),copied);
    assert.match(runtime,/^WORKDIR \/repo$/m);
    const directory=join(root,'rubrist-install'),cli=['tools/self-host/install.mjs','--backend','sqlite','--version',packageVersion(),'--directory',directory,'--public-url','http://localhost:8081'];
    const output=execFileSync(process.execPath,cli,{cwd:repository,encoding:'utf8',env:{PATH:process.env.PATH}});
    assert.match(output,/Prepared a new installation/);assert.doesNotMatch(output,/RUBRIST_AUTH_SECRET|betterAuthSecret/);
    assert.equal(readFileSync(join(directory,'compose.yaml'),'utf8'),readFileSync(join(repository,'deploy/self-host/compose.sqlite.yaml'),'utf8'));
    assert.match(readFileSync(join(directory,'.env'),'utf8'),new RegExp(`^RUBRIST_VERSION=${packageVersion().replaceAll('.','\\.')}$`,'m'));
    const mismatch=['tools/self-host/install.mjs','--backend','sqlite','--version','9.9.9','--directory',join(root,'mismatch')];
    assert.throws(()=>execFileSync(process.execPath,mismatch,{cwd:repository,encoding:'utf8',stdio:'pipe'}),error=>/must match this installer's release/.test(error.stderr));
    assert.equal(existsSync(join(root,'mismatch')),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
