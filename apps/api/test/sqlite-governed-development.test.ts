import { expect,it } from 'vitest';
import { copyFileSync,mkdirSync,mkdtempSync,readdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { migrateSqlite,openSqlite } from '@rubrist/db/sqlite';
import { CreateCriterionInputSchema } from '@rubrist/shared';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { sqliteCommand } from '../src/storage/sqlite/command-context.js';
import { governedContentV1Digest } from '../src/lib/governed-content-digest.js';
import { cleanup } from './helpers/sqlite-analysis.js';
import { MOCK_BINDING,bindingInput } from './fixtures/execution-binding.js';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'rubrist-governed-development-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const db=openSqlite(join(dir,'db.sqlite'));cleanup.push(()=>db.close());
 const history=join(dir,'history');mkdirSync(history);const source=fileURLToPath(new URL('../../../packages/db/sqlite-migrations/',import.meta.url));
 for(const file of readdirSync(source).filter(n=>n.endsWith('.sql')&&n<'0041'))copyFileSync(join(source,file),join(history,file));
 migrateSqlite(db,history);const commands=sqliteCommands(db),stamp='2026-01-01T00:00:00.000Z';
 db.prepare('INSERT INTO "user"(id,name,email,created_at,updated_at) VALUES(?,?,?,?,?)').run('owner','Owner','owner@example.test',stamp,stamp);
 const {projectId}=commands.ensureWorkspaceForUser({userId:'owner',email:'owner@example.test',owner:true});
 const create=(key:string,recorded=true)=>commands.createCriterion(projectId,CreateCriterionInputSchema.parse({stableKey:key,name:'Evidence',definition:'Use evidence',evaluator:{rubricMarkdown:'Pass grounded answers',prompt:'Review independently',executionBinding:bindingInput(MOCK_BINDING)}}),recorded?{actorUserId:'owner'}:{});
 return {db,commands,projectId,create};
}
function basis(row:Record<string,unknown>){return {activityKind:row.activity_kind,criterionVersionId:row.criterion_version_id,developerRoleAtRecording:row.developer_role_at_recording,developerSubjectId:row.developer_subject_id,skillVersionId:row.skill_version_id,sourceKind:row.source_kind};}
it('backfills exact retained recorded authorship and atomically appends future development evidence',()=>{
 const f=fixture(),old=f.create('old'),legacy=f.create('legacy',false),versionId=old.evaluator.currentVersion.id;
 const history=f.db.prepare('SELECT * FROM rubrist_sqlite_migrations ORDER BY id').all();
 const before=f.db.prepare('SELECT * FROM skill_versions WHERE id=?').get(versionId)!;
 migrateSqlite(f.db);migrateSqlite(f.db);
 expect(f.db.prepare('SELECT * FROM rubrist_sqlite_migrations ORDER BY id').all().slice(0,history.length)).toEqual(history);
 const row=f.db.prepare('SELECT * FROM governed_evaluator_development_events').get()!;
 expect(row).toMatchObject({id:'grede_'+versionId,skill_version_id:versionId,developer_subject_id:before.created_by_subject_id,occurred_at:before.created_at});
 expect(row.content_digest).toBe(governedContentV1Digest('governed-evaluator-development/v1',basis(row)));
 expect(f.db.prepare('SELECT * FROM governed_evaluator_development_events WHERE skill_version_id=?').get(legacy.evaluator.currentVersion.id)).toBeUndefined();
 const next=f.create('next').evaluator.currentVersion.id;
 const appended=f.db.prepare('SELECT * FROM governed_evaluator_development_events WHERE skill_version_id=?').get(next)!;
 expect(appended.content_digest).toBe(governedContentV1Digest('governed-evaluator-development/v1',basis(appended)));
 expect(appended.occurred_at).toBe(f.db.prepare('SELECT created_at FROM skill_versions WHERE id=?').get(next)?.created_at);
 expect(()=>f.db.exec("UPDATE governed_evaluator_development_events SET developer_subject_id='rewrite'")).toThrow(/immutable/);
 expect(()=>f.db.exec('DELETE FROM governed_evaluator_development_events')).toThrow(/project erasure/);
 expect(()=>sqliteCommand(f.db,c=>c.db.prepare('INSERT INTO governed_evaluator_development_events VALUES(?,?,?,?,?,?,?,?,?,?)').run('forged',f.projectId,legacy.versions[0]!.id,legacy.evaluator.currentVersion.id,before.created_by_subject_id!,'evaluator_developer','evaluator_development','system_recorded',row.content_digest!,c.timestamp))).toThrow(/authorship/);
 expect(f.db.prepare("SELECT name FROM sqlite_schema WHERE instr(sql,'sqlite_migration_')>0").all()).toEqual([]);
 const maintenance=openSqlite(':memory:');cleanup.push(()=>maintenance.close());
 migrateSqlite(maintenance);expect(maintenance.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all()).toEqual(f.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all());
 expect(f.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
 f.commands.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM governed_evaluator_development_events').all()).toEqual([]);
});
it('rolls back the forward migration for incompatible legacy NUL identity bytes',()=>{
 const f=fixture(),created=f.create('before'),row=f.db.prepare('SELECT * FROM skill_versions WHERE id=?').get(created.evaluator.currentVersion.id)!;
 row.id='bad\0identity';row.version='0.1.1';
 sqliteCommand(f.db,()=>f.db.prepare(`INSERT INTO skill_versions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row)));
 const before=f.db.prepare('SELECT * FROM rubrist_sqlite_migrations ORDER BY id').all();
 expect(()=>migrateSqlite(f.db)).toThrow(/CHECK/);
 expect(f.db.prepare('SELECT * FROM rubrist_sqlite_migrations ORDER BY id').all()).toEqual(before);
 expect(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='governed_evaluator_development_events'").get()).toBeUndefined();
 expect(f.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
 expect(f.db.isTransaction).toBe(false);
});
