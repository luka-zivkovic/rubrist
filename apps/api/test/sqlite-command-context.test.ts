import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { sqliteDatasetRevisionCommands } from '../src/storage/sqlite/dataset-revision-commands.js';
import { datasetRevisionContentDigest, datasetRevisionDigest } from '../src/lib/dataset-revision.js';
import { migrateSqlite, openSqlite } from '@rubrist/db/sqlite';
import { sqliteCommand, type SqliteCommandContext } from '../src/storage/sqlite/command-context.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'rubrist-command-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'db.sqlite'),db=openSqlite(path);cleanup.push(()=>db.close());migrateSqlite(db);db.exec('CREATE TABLE probe(id TEXT PRIMARY KEY,token TEXT,stamp TEXT) STRICT');return {path,db};}
it('retains a nondecreasing millisecond clock across commands, rollback and connection restart',()=>{
 const {path,db}=fixture();let first!:SqliteCommandContext;
 sqliteCommand(db,context=>{first=context;context.db.prepare('INSERT INTO probe VALUES(?,?,?)').run('one',context.token,context.timestamp);},()=>100);
 expect(first.timestamp).toBe('1970-01-01T00:00:00.100Z');
 expect(()=>db.prepare('SELECT sqlite_command_token()').get()).toThrow(/command required/);
 sqliteCommand(db,context=>{expect(context.token).not.toBe(first.token);expect(context.milliseconds).toBe(100);},()=>50);
 expect(()=>sqliteCommand(db,()=>{throw new Error('rollback');},()=>200)).toThrow('rollback');
 const peer=openSqlite(path);cleanup.push(()=>peer.close());
 sqliteCommand(peer,context=>expect(context.milliseconds).toBe(100),()=>75);
 expect(()=>sqliteCommand(peer,()=>{},()=>NaN)).toThrow(/clock/);expect(peer.isTransaction).toBe(false);
 sqliteCommand(peer,context=>expect(context.milliseconds).toBe(110),()=>110);
 expect(()=>peer.prepare('UPDATE rubrist_command_clock SET last_ms=0').run()).toThrow();
 const plain=openSqlite(path);cleanup.push(()=>plain.close());expect(()=>plain.prepare('UPDATE rubrist_command_clock SET last_ms=1000').run()).toThrow(/function/);
});
it('rejects transaction escape, implicit rollback, stale handles, nested and asynchronous work',()=>{
 const {db}=fixture();db.prepare("INSERT INTO probe VALUES('existing','t','s')").run();
 for(const sql of ['COMMIT','ROLLBACK','BEGIN','SAVEPOINT attempt_escape']) {
  const prepared=db.prepare(sql);
  expect(()=>sqliteCommand(db,context=>{context.db.prepare("INSERT INTO probe VALUES('escaped','t','s')").run();prepared.run();})).toThrow(/authorized/);
  expect(db.prepare("SELECT * FROM probe WHERE id='escaped'").get()).toBeUndefined();
 }
 let old!:SqliteCommandContext,statement!:ReturnType<SqliteCommandContext['db']['prepare']>;
 sqliteCommand(db,context=>{old=context;statement=context.db.prepare("INSERT INTO probe VALUES('stale','t','s')");});
 expect(()=>old.db.exec("INSERT INTO probe VALUES('stale','t','s')")).toThrow(/ownership lost/);
 expect(()=>sqliteCommand(db,()=>statement.run())).toThrow(/ownership lost/);
 expect(()=>sqliteCommand(db,context=>{
  const insert=context.db.prepare("INSERT INTO probe VALUES('escaped','t','s')");
  expect(()=>context.db.exec("INSERT OR ROLLBACK INTO probe VALUES('existing','t','s')")).toThrow(/UNIQUE/);
  insert.run();
 })).toThrow(/ownership lost/);
 expect(db.prepare('SELECT count(*) n FROM probe').get()?.n).toBe(1);
 expect(()=>sqliteCommand(db,()=>sqliteCommand(db,()=>{}))).toThrow(/Nested/);
 let ran=false;expect(()=>sqliteCommand(db,async()=>{ran=true;})).toThrow(/Synchronous/);expect(ran).toBe(false);
 expect(()=>sqliteCommand(db,()=>Promise.resolve())).toThrow(/Synchronous/);
});
it('makes each mutable stream command prove completeness and refuses later events after validation',()=>{
 const {db}=fixture();
 db.exec(`CREATE TABLE events(id TEXT PRIMARY KEY,stream TEXT NOT NULL,token TEXT NOT NULL,stamp TEXT NOT NULL,
  FOREIGN KEY(stream,token) REFERENCES validations(stream,token) DEFERRABLE INITIALLY DEFERRED) STRICT;
 CREATE TABLE validations(stream TEXT NOT NULL,token TEXT NOT NULL,PRIMARY KEY(stream,token)) STRICT;
 CREATE TRIGGER event_guard BEFORE INSERT ON events BEGIN
  SELECT CASE WHEN NEW.token<>sqlite_command_token() OR NEW.stamp<>sqlite_command_time() OR EXISTS(SELECT 1 FROM validations WHERE stream=NEW.stream AND token=NEW.token) THEN RAISE(ABORT,'event command mismatch or already validated') END;
 END;
 CREATE TRIGGER validation_guard BEFORE INSERT ON validations BEGIN
  SELECT CASE WHEN NEW.token<>sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM events WHERE stream=NEW.stream AND token=NEW.token) THEN RAISE(ABORT,'validation command mismatch') END;
 END;`);
 const append=(context:SqliteCommandContext,id:string)=>context.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id,'lineage',context.token,context.timestamp);
 const validate=(context:SqliteCommandContext)=>context.db.prepare('INSERT INTO validations VALUES(?,?)').run('lineage',context.token);
 expect(()=>sqliteCommand(db,context=>append(context,'incomplete'))).toThrow(/FOREIGN KEY/);
 sqliteCommand(db,context=>{append(context,'first');validate(context);});
 expect(()=>sqliteCommand(db,context=>append(context,'unvalidated-next'))).toThrow(/FOREIGN KEY/);
 expect(()=>sqliteCommand(db,context=>{append(context,'next');validate(context);append(context,'late');})).toThrow(/already validated/);
 expect(()=>db.prepare("INSERT INTO events VALUES('plain','lineage','forged','2000-01-01T00:00:00.000Z')").run()).toThrow(/command required/);
 expect(db.prepare('SELECT id FROM events').all()).toEqual([{id:'first'}]);
});

function insertRow(db:DatabaseSync,table:string,row:Record<string,SQLInputValue>) {
 db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
}
it('seeds the command clock from retained M3 times and enforces real ingestion/exposure timestamps',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rubrist-command-upgrade-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'db.sqlite'),db=openSqlite(path);cleanup.push(()=>db.close());
 const history=join(dir,'migrations');mkdirSync(history);
 const source=fileURLToPath(new URL('../../../packages/db/sqlite-migrations/',import.meta.url));
 for(const name of readdirSync(source).filter(name=>name.endsWith('.sql')&&name<'0024'))copyFileSync(join(source,name),join(history,name));
 migrateSqlite(db,history);sqliteDatasetRevisionCommands(db);
 const caseStamp='2030-01-01T00:00:00.123Z',exposureStamp='2030-01-01T00:00:01.234Z';
 db.prepare('INSERT INTO organizations VALUES(?,?,?)').run('org','Org',caseStamp);
 insertRow(db,'projects',{id:'project',organization_id:'org',name:'Project',created_at:caseStamp,updated_at:caseStamp});
 const raw={id:'raw',project_id:'project',source:'manual',source_trace_id:'source',raw_payload:'{}',normalization_version:'v1',created_at:caseStamp};
 insertRow(db,'raw_traces',raw);
 const retainedCase={id:'case',project_id:'project',raw_trace_id:'raw',case_type:'manual',normalized_payload:'{}',created_at:caseStamp,ingestion_purpose:'analysis_eligible_manual'};
 insertRow(db,'cases',retainedCase);
 const retainedIdentity={id:'identity',project_id:'project',source_case_id:'case',record_kind:'authoring_import',identity_basis:'input-identity/v1',input_digest:'sha256:'+'a'.repeat(64),created_at:caseStamp};
 insertRow(db,'case_input_identity_records',retainedIdentity);
 db.exec('BEGIN IMMEDIATE');
 insertRow(db,'dataset_revisions',{id:'revision',project_id:'project',series_id:'series',revision_number:1,role:'analysis_authoring',source_kind:'collection_snapshot',identity_basis:'input-identity/v1',content_digest:datasetRevisionContentDigest([]),revision_digest:datasetRevisionDigest({role:'analysis_authoring',itemDigests:[]}),item_count:0,provenance_level:'unverified',created_at:caseStamp});
 const retainedExposure={id:'exposure',project_id:'project',revision_id:'revision',kind:'created',exposure_class:'lineage',activity:'revision_create',subject_kind:'system',details:'{}',idempotency_key:'created',occurred_at:exposureStamp};
 insertRow(db,'dataset_exposure_events',retainedExposure);
 insertRow(db,'dataset_revision_finalizations',{revision_id:'revision',project_id:'project'});db.exec('COMMIT');
 const previousMigrations=db.prepare('SELECT * FROM rubrist_sqlite_migrations ORDER BY id').all();
 migrateSqlite(db);migrateSqlite(db);
 expect(db.prepare('SELECT * FROM rubrist_sqlite_migrations ORDER BY id').all().slice(0,previousMigrations.length)).toEqual(previousMigrations);
 expect(db.prepare('SELECT * FROM cases WHERE id=?').get('case')).toEqual(retainedCase);
 expect(db.prepare('SELECT * FROM case_input_identity_records WHERE id=?').get('identity')).toEqual(retainedIdentity);
 expect(db.prepare('SELECT * FROM governed_input_identity_claims').all()).toEqual([{project_id:'project',input_digest:retainedIdentity.input_digest,usage_class:'nonsealed',created_at:caseStamp}]);
 expect(db.prepare('SELECT occurred_at FROM dataset_exposure_events WHERE id=?').get('exposure')?.occurred_at).toBe(exposureStamp);
 sqliteCommand(db,context=>expect(context.timestamp).toBe(exposureStamp),()=>Date.parse(caseStamp));
 insertRow(db,'raw_traces',{...raw,id:'raw-next',source_trace_id:'next'});
 const nextCase={...retainedCase,id:'case-next',raw_trace_id:'raw-next'};
 const nextExposure={...retainedExposure,id:'exposure-next',idempotency_key:'next'};
 expect(()=>sqliteCommand(db,()=>insertRow(db,'cases',nextCase),()=>Date.parse(exposureStamp))).toThrow(/ingestion time/);
 expect(()=>sqliteCommand(db,()=>insertRow(db,'dataset_exposure_events',{...nextExposure,occurred_at:caseStamp}),()=>Date.parse(exposureStamp))).toThrow(/exposure time/);
 const plain=openSqlite(path);cleanup.push(()=>plain.close());
 expect(()=>insertRow(plain,'cases',{...nextCase,created_at:exposureStamp})).toThrow(/function/);
 expect(()=>insertRow(plain,'dataset_exposure_events',nextExposure)).toThrow(/function/);
 sqliteCommand(db,context=>{
  insertRow(db,'cases',{...nextCase,created_at:context.timestamp});
  insertRow(db,'dataset_exposure_events',{...nextExposure,occurred_at:context.timestamp});
 },()=>Date.parse(exposureStamp));
 expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
});
