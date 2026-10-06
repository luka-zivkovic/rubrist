#!/usr/bin/env node
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream,mkdirSync,openSync,closeSync,fsyncSync,writeFileSync,readFileSync,readdirSync,lstatSync,existsSync,linkSync,unlinkSync,rmSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

class MaintenanceError extends Error {}
const migrations=new URL('../../packages/db/sqlite-migrations/',import.meta.url);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fingerprint=secret=>'rbfp1:'+createHmac('sha256',secret).update('rubrist/auth-secret-fingerprint/v1').digest('hex').slice(0,32);
function sync(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function privateFile(path){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))throw new MaintenanceError('Recovery files must be regular files readable only by their owner (0600).');}
export function secretRecord(path){privateFile(path);const record=JSON.parse(readFileSync(path,'utf8'));if(record.format!=='rubrist-auth-recovery-v1'||typeof record.betterAuthSecret!=='string'||!record.betterAuthSecret.trim())throw new MaintenanceError('Invalid auth recovery record');return record.betterAuthSecret;}
async function fileDigest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
function inspect(path,exact=false){
  const db=new DatabaseSync(path,{readOnly:true,timeout:5000});
  try{
    const check=db.prepare('PRAGMA integrity_check').all();
    if(check.length!==1||check[0].integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new MaintenanceError('Backup integrity verification failed');
    const history=db.prepare('SELECT id,checksum FROM rubrist_sqlite_migrations ORDER BY id').all();
    const files=readdirSync(migrations).filter(file=>file.endsWith('.sql')).sort();
    if(db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB '*__new'").all().length)throw new MaintenanceError('Backup contains unfinished migration tables');
    if(!history.length||(exact&&history.length!==files.length)||history.length>files.length||history.some((row,index)=>row.id!==files[index]||row.checksum!==digest(readFileSync(new URL(row.id,migrations)))))throw new MaintenanceError('Backup schema is incompatible with this application version');
    return history.map(row=>({id:row.id,checksum:row.checksum}));
  }finally{db.close();}
}
export function createRecoveryRecord(path,secret=process.env.BETTER_AUTH_SECRET){
  if(!secret?.trim())throw new MaintenanceError('BETTER_AUTH_SECRET is required; run this command with the installation environment');
  writeFileSync(path,JSON.stringify({format:'rubrist-auth-recovery-v1',betterAuthSecret:secret},null,2)+'\n',{flag:'wx',mode:0o600});sync(path);sync(dirname(resolve(path)));
}
export async function createBackup({source,output,recoveryFile,secret=process.env.BETTER_AUTH_SECRET}){
  if(!secret?.trim()||secretRecord(recoveryFile)!==secret)throw new MaintenanceError('Auth recovery record does not match the installation secret');
  const root=resolve(output),input=resolve(source),recovery=resolve(recoveryFile);
  if(input.startsWith(root+'/')||recovery.startsWith(root+'/'))throw new MaintenanceError('Database and recovery record must be outside the new backup directory');
  // Exclusive directory ownership; manifest is written last as the completion marker.
  mkdirSync(root,{mode:0o700});
  let db;
  try{
    const target=join(root,'database.sqlite');
    closeSync(openSync(target,'wx',0o600));
    db=new DatabaseSync(input,{readOnly:true,timeout:5000});
    db.exec('BEGIN');
    db.prepare('SELECT count(*) FROM sqlite_schema').get(); // Pin one committed read snapshot during the copy.
    await backup(db,target,{rate:2147483647});
    db.exec('ROLLBACK');db.close();db=undefined;
    // Backup may inherit WAL mode. Closing this sole connection checkpoints it,
    // then DELETE mode makes the portable artifact self-contained.
    const snapshot=new DatabaseSync(target);try{snapshot.exec('PRAGMA journal_mode=DELETE');}finally{snapshot.close();}
    if(existsSync(target+'-wal')||existsSync(target+'-shm'))throw new MaintenanceError('Backup has unexpected WAL sidecars');
    const history=inspect(target,true);
    sync(target);
    const manifest={format:'rubrist-sqlite-backup-v1',createdAt:new Date().toISOString(),nodeVersion:process.versions.node,sqliteVersion:process.versions.sqlite,sha256:await fileDigest(target),authSecretFingerprint:fingerprint(secret),history};
    writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
    sync(join(root,'manifest.json'));sync(root);sync(dirname(root));
    return manifest;
  }catch(error){try{db?.close();}finally{rmSync(root,{recursive:true,force:true});}throw error;}
}
export async function restoreBackup({backupDirectory,target,recoveryFile,secret:targetSecret=process.env.BETTER_AUTH_SECRET}){
  const root=resolve(backupDirectory),destination=resolve(target);
  const secret=secretRecord(recoveryFile);
  if(!targetSecret || targetSecret!==secret)throw new MaintenanceError('Target installation secret does not match the auth recovery record');
  const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
  if(manifest.format!=='rubrist-sqlite-backup-v1'||manifest.authSecretFingerprint!==fingerprint(secret)||!Array.isArray(manifest.history)||!/^[a-f0-9]{64}$/.test(manifest.sha256))throw new MaintenanceError('Backup metadata or auth recovery record does not match');
  if([destination,destination+'-wal',destination+'-shm',destination+'-journal'].some(existsSync))throw new MaintenanceError('Restore requires a new database path with no database or sidecar files');
  const temporary=join(dirname(destination),`.rubrist-restore-${randomUUID()}.sqlite`);
  try{
    // Copy into an exclusive private file; verify the copied bytes, not a prior source read.
    closeSync(openSync(temporary,'wx',0o600));
    await pipeline(createReadStream(join(root,'database.sqlite')),createWriteStream(temporary,{flags:'r+'}));
    if(await fileDigest(temporary)!==manifest.sha256)throw new MaintenanceError('Backup checksum mismatch');
    if(JSON.stringify(inspect(temporary))!==JSON.stringify(manifest.history))throw new MaintenanceError('Backup schema metadata mismatch');
    sync(temporary);
    if([destination+'-wal',destination+'-shm',destination+'-journal'].some(existsSync))throw new MaintenanceError('Restore destination has sidecar files');
    // Hard-link publication refuses a racing existing target; same-directory temp
    // keeps this atomic on the supported local filesystem.
    linkSync(temporary,destination);unlinkSync(temporary);sync(dirname(destination));
  }finally{if(existsSync(temporary))unlinkSync(temporary);}
}
export function writeRecoveryEnv({recoveryFile,output}){
  const secret=secretRecord(recoveryFile);
  // Compose literal single-quoted values cannot contain a newline or quote.
  if(/[\r\n'\0]/.test(secret)||secret.endsWith('\\'))throw new MaintenanceError('Recovery secret requires manual protected environment configuration');
  writeFileSync(output,`RUBRIST_AUTH_SECRET='${secret}'\n`,{flag:'wx',mode:0o600});sync(output);sync(dirname(resolve(output)));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const action=process.argv[2],options={};
    const names={'--source':'source','--output':'output','--recovery-file':'recoveryFile','--backup':'backupDirectory','--target':'target'};
    for(let i=3;i<process.argv.length;i+=2){const key=names[process.argv[i]];if(!key||!process.argv[i+1]||Object.hasOwn(options,key))throw new MaintenanceError('Invalid command options');options[key]=process.argv[i+1];}
    if(action==='recovery'&&options.output)createRecoveryRecord(options.output);
    else if(action==='backup'&&options.source&&options.output&&options.recoveryFile)await createBackup(options);
    else if(action==='restore'&&options.backupDirectory&&options.target&&options.recoveryFile)await restoreBackup(options);
    else if(action==='recovery-env'&&options.recoveryFile&&options.output)writeRecoveryEnv(options);
    else throw new MaintenanceError('Usage: sqlite-backup.mjs recovery|backup|restore|recovery-env (see docs/sqlite-operations.md)');
    console.log(`SQLite ${action} completed. Keep backups and auth recovery records protected and off-host.`);
  }catch(error){console.error(error instanceof MaintenanceError ? error.message : 'SQLite maintenance failed. Check file formats, paths, permissions, free space and that outputs do not already exist.');process.exitCode=1;}
}
