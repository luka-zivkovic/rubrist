import {expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,readdirSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openSqlite,migrateSqlite} from '@rubrist/db/sqlite';
import {CreateCriterionInputSchema} from '@rubrist/shared';
import {sqliteCommands} from '../src/storage/sqlite/commands.js';
import {MOCK_BINDING,bindingInput} from './fixtures/execution-binding.js';
import {evaluatorExecutionAuthorizationDigest} from '../src/lib/evaluator-lifecycle.js';
it('preserves historical authorization bytes and replay when upgrading an existing pre-lifecycle database',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rubrist-candidate-upgrade-')),migrations=join(dir,'migrations'),path=join(dir,'db.sqlite');mkdirSync(migrations);
 const source=new URL('../../../packages/db/sqlite-migrations/',import.meta.url);
 for(const file of readdirSync(source).filter(f=>f.endsWith('.sql')&&f<'0063'))copyFileSync(new URL(file,source),join(migrations,file));
 let db=openSqlite(path);
 try{
  migrateSqlite(db,migrations);const commands=sqliteCommands(db);
  db.exec("INSERT INTO organizations VALUES('org','Upgrade','2020-01-01T00:00:00.000Z');INSERT INTO projects(id,organization_id,name,created_at,updated_at) VALUES('project','org','Upgrade','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')");
  const created=commands.createCriterion('project',CreateCriterionInputSchema.parse({stableKey:'upgrade',name:'Upgrade',definition:'Synthetic upgrade criterion',evaluator:{rubricMarkdown:'Pass supported answers.',prompt:'Evaluate',executionBinding:bindingInput(MOCK_BINDING)}}),{});
  const version=commands.getCurrentSkillForCriterion('project',created.criterion.id).currentVersion.id;
  const input={projectId:'project',skillVersionId:version,context:'explicit_nonproduction_dataset' as const,resourceKind:'fixture',resourceId:'😀 exact',idempotencyKey:'old'};
  const digest=evaluatorExecutionAuthorizationDigest({...input,lifecycleEventId:null,calibrationArtifactId:null});
  db.prepare("INSERT INTO evaluator_execution_authorizations(rowid,id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest,authorized_at) VALUES(91,'old','rubrist/evaluator-execution-authorization/v1','project',?,'explicit_nonproduction_dataset',NULL,NULL,'fixture','😀 exact','old',?,'1777777777777')").run(version,digest);
  const before=db.prepare('SELECT rowid,* FROM evaluator_execution_authorizations').all();db.close();
  db=openSqlite(path);migrateSqlite(db);expect(db.prepare('SELECT rowid,* FROM evaluator_execution_authorizations').all()).toEqual(before);
  const after=sqliteCommands(db);after.authorizeSkillVersionExecution(input);expect(db.prepare('SELECT rowid,* FROM evaluator_execution_authorizations').all()).toEqual(before);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB '*__new'").all()).toEqual([]);
 }finally{if(db.isOpen)db.close();rmSync(dir,{recursive:true,force:true});}
});
