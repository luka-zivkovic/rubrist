import {DatabaseSync} from 'node:sqlite';
import {chmodSync,lstatSync,realpathSync,statSync,statfsSync,existsSync} from 'node:fs';
import {dirname,basename,join} from 'node:path';

/** OS-backed lifetime lock; process death releases ownership without stale lock cleanup. */
export function acquireSqliteInstance(path:string,requireMount=false):DatabaseSync {
  const directory=realpathSync(dirname(path));
  if(!statSync(directory).isDirectory())throw new Error('SQLite requires an existing database directory');
  if(requireMount && (statSync(directory).dev===statSync('/').dev || statfsSync(directory).type===0x01021994)) {
    throw new Error('SQLite requires a persistent mounted local volume');
  }
  if(lstatSync(path,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error('SQLite requires a database file inside the persistent mounted local volume, not a symlink');
  const canonical=existsSync(path)?realpathSync(path):join(directory,basename(path));
  if(lstatSync(canonical+'.instance-lock',{throwIfNoEntry:false})?.isSymbolicLink())throw new Error('SQLite instance lock cannot be a symlink');
  const lock=new DatabaseSync(canonical+'.instance-lock',{timeout:100});
  try {
    chmodSync(canonical+'.instance-lock',0o600);
    lock.exec('PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS instance_owner (singleton INTEGER PRIMARY KEY) STRICT');
    return lock;
  }catch(error){lock.close();throw error;}
}
