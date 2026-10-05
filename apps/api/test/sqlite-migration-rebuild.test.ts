import { afterEach, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openSqlite, migrateSqlite } from '@rubrist/db/sqlite';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const baseline=`CREATE TABLE parent(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL) STRICT;
CREATE TABLE child(id TEXT PRIMARY KEY NOT NULL,parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE,bytes BLOB NOT NULL) STRICT;
CREATE TRIGGER child_owner BEFORE INSERT ON child WHEN NOT EXISTS(SELECT 1 FROM parent WHERE id=NEW.parent_id) BEGIN SELECT RAISE(ABORT,'missing owner'); END;`;
const rebuild=`CREATE TEMP TABLE rebuild_assert(ok INTEGER CHECK(ok=1));
CREATE TABLE parent__new(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL,extra TEXT) STRICT;
INSERT INTO parent__new(rowid,id,value) SELECT rowid,id,value FROM parent;
INSERT INTO rebuild_assert SELECT NOT EXISTS(SELECT rowid,id,value FROM parent EXCEPT SELECT rowid,id,value FROM parent__new);
INSERT INTO rebuild_assert SELECT (SELECT count(*) FROM parent)=(SELECT count(*) FROM parent__new);
SELECT migration_checkpoint('after-copy');
DROP TRIGGER child_owner;
DROP TABLE parent;
SELECT migration_checkpoint('mid-swap');
ALTER TABLE parent__new RENAME TO parent;
CREATE TRIGGER child_owner BEFORE INSERT ON child WHEN NOT EXISTS(SELECT 1 FROM parent WHERE id=NEW.parent_id) BEGIN SELECT RAISE(ABORT,'missing owner'); END;
DROP TABLE rebuild_assert;
SELECT migration_checkpoint('before-ledger');`;
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'rubrist-migration-rebuild-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'db.sqlite'),migrations=join(dir,'migrations');mkdirSync(migrations);writeFileSync(join(migrations,'0001_initial.sql'),baseline);
  const db=openSqlite(path);cleanup.push(()=>db.close());migrateSqlite(db,migrations);
  db.exec("INSERT INTO parent VALUES('one','😀 retained');INSERT INTO child VALUES('evidence','one',x'00ff80c3a900')");
  const before={parent:db.prepare('SELECT rowid,* FROM parent').all(),child:db.prepare('SELECT rowid,id,parent_id,hex(bytes) bytes,typeof(bytes) storage FROM child').all()};
  writeFileSync(join(migrations,'0002_rebuild.sql'),rebuild);
  db.function('migration_checkpoint',(_point)=>1);
  return {dir,path,migrations,db,before};
}
describe('SQLite migration-only table rebuild ownership',()=>{
  it('preserves cascade children, rowids and exact BLOBs and restores enforcement',()=> {
    const f=fixture();migrateSqlite(f.db,f.migrations);migrateSqlite(f.db,f.migrations);
    expect(f.db.prepare('SELECT rowid,id,value FROM parent').all()).toEqual(f.before.parent);
    expect(f.db.prepare('SELECT rowid,id,parent_id,hex(bytes) bytes,typeof(bytes) storage FROM child').all()).toEqual(f.before.child);
    expect(f.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(f.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(()=>f.db.exec("INSERT INTO child VALUES('bad','missing',x'00')")).toThrow(/owner/);
    f.db.exec("DELETE FROM parent WHERE id='one'");expect(f.db.prepare('SELECT * FROM child').all()).toEqual([]);
  });
  it.each([
    "CREATE TABLE orphan(id TEXT REFERENCES parent(id)) STRICT;INSERT INTO orphan VALUES('missing');",
    'CREATE TABLE leftover__new(id TEXT) STRICT;',
    'CREATE TEMP TABLE leftovers(id TEXT);',
    rebuild.replace('SELECT rowid,id,value FROM parent;','SELECT rowid,id,value FROM parent WHERE 0;')
  ])('rolls back invalid or incomplete rebuilding and restores connection FK state',sql=> {
    const f=fixture();writeFileSync(join(f.migrations,'0002_rebuild.sql'),sql);
    expect(()=>migrateSqlite(f.db,f.migrations)).toThrow();
    expect(f.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(f.db.prepare('SELECT rowid,* FROM parent').all()).toEqual(f.before.parent);
    expect(f.db.prepare('SELECT count(*) n FROM rubrist_sqlite_migrations').get()?.n).toBe(1);
    expect(f.db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('orphan','leftover__new')").all()).toEqual([]);
  });
  it.each(['COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT escaped', 'RELEASE escaped'])('rejects migration transaction control %s before it can escape rollback',control=> {
    const f=fixture();
    writeFileSync(join(f.migrations,'0002_rebuild.sql'),`CREATE TABLE orphan(id TEXT REFERENCES parent(id)) STRICT; INSERT INTO orphan VALUES('missing'); ${control};`);
    expect(()=>migrateSqlite(f.db,f.migrations)).toThrow(/authoriz/i);
    expect(f.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='orphan'").all()).toEqual([]);
    expect(f.db.prepare('SELECT count(*) n FROM rubrist_sqlite_migrations').get()?.n).toBe(1);
    expect(f.db.prepare('SELECT rowid,* FROM parent').all()).toEqual(f.before.parent);
    expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it.each(['after-copy','mid-swap','before-ledger','after-commit'])('SIGKILL at %s leaves only a complete old or new database',async point=> {
    const f=fixture(),marker=join(f.dir,'checkpoint');
    const child=fork(fileURLToPath(new URL('./fixtures/sqlite-interrupted-migration.ts',import.meta.url)),[f.path,f.migrations,marker,point],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
    cleanup.push(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
    let errors='';child.stderr?.on('data',value=>{errors+=value;});
    for(let attempt=0;!existsSync(marker);attempt++) {
      if(attempt>200||child.exitCode!==null)throw new Error(`Migration checkpoint failed: ${errors}`);
      await delay(10);
    }
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    const reader=openSqlite(f.path);cleanup.push(()=>reader.close());
    expect(reader.prepare('SELECT count(*) n FROM rubrist_sqlite_migrations').get()?.n).toBe(point==='after-commit'?2:1);
    expect(reader.prepare('SELECT rowid,id,value FROM parent').all()).toEqual(f.before.parent);
    expect(reader.prepare('SELECT rowid,id,parent_id,hex(bytes) bytes,typeof(bytes) storage FROM child').all()).toEqual(f.before.child);
    expect(reader.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(reader.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(reader.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  });
});
