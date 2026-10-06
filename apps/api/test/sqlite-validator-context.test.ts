import { afterEach, expect, it } from 'vitest';
import { openSqlite,migrateSqlite } from '@rubrist/db/sqlite';
import { registerSqliteValidator,sqliteCommand,type SqliteValidatorReader } from '../src/storage/sqlite/command-context.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function fixture(){const db=openSqlite(':memory:');cleanup.push(()=>db.close());migrateSqlite(db);db.exec('CREATE TABLE inputs(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO inputs VALUES(1,\'a\'),(2,\'b\'); CREATE TABLE checks(id INTEGER PRIMARY KEY);');return db;}
function guard(db:ReturnType<typeof openSqlite>,name='analysis_fixture_valid_v1'){
 db.exec(`CREATE TRIGGER fixture_validate BEFORE INSERT ON checks BEGIN SELECT CASE WHEN ${name}(NEW.id) IS NOT 1 THEN RAISE(ABORT,'invalid fixture') END; END;`);
}
it('streams uncommitted data through a scoped reader and closes abandoned cursors',()=>{
 const db=fixture();let escaped:SqliteValidatorReader|undefined,iterator:IterableIterator<unknown>|undefined;
 registerSqliteValidator(db,'analysis_fixture_valid_v1',['fixture_validate'],reader=>{escaped=reader;iterator=reader.iterate('SELECT * FROM inputs ORDER BY id');expect(iterator.next().value).toEqual({id:1,value:'a'});return reader.get('SELECT count(*) n FROM inputs')?.n===3;});guard(db);
 sqliteCommand(db,c=>{c.db.exec("INSERT INTO inputs VALUES(3,'c')");c.db.exec('INSERT INTO checks VALUES(1)');});
 expect(()=>escaped!.get('SELECT 1')).toThrow(/scope expired/);expect(()=>iterator!.next()).toThrow(/scope expired/);
 expect(db.prepare('SELECT count(*) n FROM checks').get()?.n).toBe(1);
 expect(()=>sqliteCommand(db,c=>c.db.prepare('SELECT analysis_fixture_valid_v1(1)').get())).toThrow(/not authorized/);
 expect(db.prepare('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
});
it.each(['DELETE FROM inputs RETURNING id','PRAGMA user_version','SAVEPOINT escape','SELECT analysis_fixture_valid_v1(1)'])('rejects validator mutation, connection access, or reentry: %s',sql=>{
 const db=fixture();registerSqliteValidator(db,'analysis_fixture_valid_v1',['fixture_validate'],reader=>{reader.get(sql);return true;});guard(db);
 expect(()=>sqliteCommand(db,c=>c.db.exec('INSERT INTO checks VALUES(1)'))).toThrow(/invalid fixture/);
 expect(db.prepare('SELECT count(*) n FROM inputs').get()?.n).toBe(2);expect(db.prepare('SELECT count(*) n FROM checks').get()?.n).toBe(0);
 sqliteCommand(db,c=>c.db.exec("INSERT INTO inputs VALUES(3,'still usable')"));
});
it('returns a database guard error for thrown or asynchronous verdicts and restores command ownership',()=>{
 const db=fixture();let mode=0;
 registerSqliteValidator(db,'analysis_fixture_valid_v1',['fixture_validate'],reader=>{reader.iterate('SELECT * FROM inputs ORDER BY id').next();if(mode===0)throw new Error('internal validator details');return Promise.resolve(true) as unknown as boolean;});guard(db);
 for(mode=0;mode<2;mode++){
  expect(()=>sqliteCommand(db,c=>c.db.exec('INSERT INTO checks VALUES(1)'))).toThrow(/invalid fixture/);
  expect(db.isTransaction).toBe(false);
 }
 expect(()=>sqliteCommand(db,c=>c.db.exec('COMMIT'))).toThrow(/not authorized/);
});
it('never declares registered validator references outside triggers in the application schema',()=>{
 const db=fixture();
 for(const row of db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE sql IS NOT NULL AND type<>'trigger'").all())expect(String(row.sql)).not.toMatch(/analysis_[a-z0-9_]+_valid_v[1-9][0-9]*\s*\(/);
});
it.each([
 ['same-name temp trigger',"CREATE TEMP TRIGGER fixture_validate AFTER INSERT ON inputs BEGIN SELECT analysis_fixture_valid_v1(NEW.id); END"],
 ['same-name view','CREATE VIEW fixture_validate AS SELECT analysis_fixture_valid_v1(1) v'],
 ['check suppression','PRAGMA ignore_check_constraints=ON'],
 ['attachment',"ATTACH ':memory:' AS shadow"],
 ['guard removal','DROP TRIGGER fixture_validate']
])('denies administrative %s inside a managed command',(_label,sql)=>{
 const db=fixture();let calls=0;registerSqliteValidator(db,'analysis_fixture_valid_v1',['fixture_validate'],()=>{calls++;return true;});guard(db);
 expect(()=>sqliteCommand(db,c=>c.db.exec(sql))).toThrow(/not authorized/);
 expect(db.prepare("SELECT count(*) n FROM sqlite_temp_schema").get()?.n).toBe(0);
 expect(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='fixture_validate' AND type='trigger'").get()?.n).toBe(1);
 expect(db.prepare('PRAGMA ignore_check_constraints').get()).toEqual({ignore_check_constraints:0});
 expect(db.prepare('PRAGMA database_list').all().map(row=>row.name)).not.toContain('shadow');
 sqliteCommand(db,c=>c.db.exec('INSERT INTO checks VALUES(1)'));expect(calls).toBe(1);
 // Outside a command, schema maintenance remains an administrative boundary.
 db.exec('PRAGMA ignore_check_constraints=OFF');
});
