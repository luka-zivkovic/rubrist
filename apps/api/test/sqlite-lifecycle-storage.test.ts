import {sqliteCommand} from '../src/storage/sqlite/command-context.js';
import {expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {governedFixture} from './helpers/sqlite-governed.js';
it('preserves native context projections on a plain connection while unclaimed lifecycle writes remain forbidden',async()=>{
 const f=await governedFixture(),version=f.db.prepare('SELECT id FROM skill_versions WHERE project_id=? AND criterion_version_id=?').get(f.projectId,f.criterionVersionId)!;
 expect(()=>sqliteCommand(f.db,c=>c.db.exec('INSERT INTO evaluator_lifecycles DEFAULT VALUES'))).toThrow(/owning unfinalized candidate claim/);
 expect(()=>sqliteCommand(f.db,c=>c.db.exec('INSERT INTO evaluator_lifecycle_events DEFAULT VALUES'))).toThrow(/owning unfinalized candidate claim/);
 const plain=new DatabaseSync(f.path,{readOnly:true});try{
  expect(plain.prepare('SELECT explicit_allowed,implicit_allowed FROM evaluator_lifecycle_contexts WHERE project_id=? AND skill_version_id=?').get(f.projectId,version.id!)).toEqual({explicit_allowed:1,implicit_allowed:1});
  expect(plain.prepare('SELECT * FROM evaluator_lifecycle_heads').all()).toEqual([]);expect(plain.prepare('SELECT * FROM evaluator_lifecycle_admissibility').all()).toEqual([]);
  expect(plain.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(plain.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
 }finally{plain.close();}
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});expect(f.db.prepare('SELECT * FROM evaluator_lifecycle_contexts').all()).toEqual([]);
});
