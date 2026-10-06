import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite } from '@rubrist/db/sqlite';
import { createUnseededSqliteRuntime } from './helpers/sqlite.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import { revision, first, existing } from './helpers/sqlite-taxonomy.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});
async function fixture(){
 vi.stubEnv('BETTER_AUTH_SECRET','sqlite-taxonomy-secret-at-least-32-characters');
 const dir=mkdtempSync(join(tmpdir(),'rubrist-taxonomy-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'db.sqlite'),runtime=await createUnseededSqliteRuntime(path);cleanup.push(()=>runtime.close());
 const {user}=await runtime.auth.api.signUpEmail({body:{email:'owner@example.test',password:'synthetic-long-password',name:'Owner'}});
 const {projectId}=await runtime.accounts.ensureWorkspaceForUser({userId:user.id,email:user.email,owner:true});
 const db=openSqlite(path);cleanup.push(()=>db.close());sqliteCommands(db);
 db.prepare('INSERT INTO governed_reviewer_subjects VALUES(?,?,?,sqlite_subject_digest(?,?),?)').run('subject',projectId,user.id,projectId,'subject',new Date().toISOString());
 return {db,runtime,projectId,userId:user.id};
}
it('freezes complete initial and successor taxonomy code sets and immutable retirement',async()=>{
 const f=await fixture();revision(f);revision(f,[existing(),{kind:'new',clientToken:'second',label:'Wrong order',definition:'Steps occur out of order'}]);
 revision(f,[existing('retired'),{kind:'existing',codeId:'revision-2-second',label:'Wrong order',definition:'Steps occur out of order',status:'active'}]);
 expect(f.db.prepare('SELECT count(*) n FROM analysis_failure_taxonomy_revisions').get()?.n).toBe(3);
 for(const table of ['analysis_failure_taxonomies','analysis_failure_taxonomy_revisions','analysis_failure_codes','analysis_failure_taxonomy_revision_codes','analysis_taxonomy_finalizations'])expect(()=>f.db.exec(`DELETE FROM ${table}`)).toThrow(/project erasure/);
 expect(()=>f.db.exec("UPDATE analysis_failure_taxonomy_revision_codes SET label='rewritten'")).toThrow(/immutable/);
 await f.runtime.repository.deleteProject(f.projectId,{confirmProjectName:'Default Project'});
 expect(f.db.prepare('SELECT * FROM analysis_failure_taxonomy_revisions').all()).toEqual([]);expect(f.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it.each([
 ['analysis_failure_taxonomies','created_by_user_id','foreign'],['analysis_failure_taxonomies','content_digest','sha256:'+'a'.repeat(64)],['analysis_failure_taxonomies','initial_revision_id','missing'],
 ['analysis_failure_taxonomy_revisions','sequence',2],['analysis_failure_taxonomy_revisions','request_digest','sha256:'+'a'.repeat(64)],['analysis_failure_taxonomy_revisions','revision_digest','sha256:'+'a'.repeat(64)],
 ['analysis_failure_codes','client_token','different'],['analysis_failure_codes','content_digest','sha256:'+'a'.repeat(64)],['analysis_failure_taxonomy_revision_codes','entry_digest','sha256:'+'a'.repeat(64)],['analysis_taxonomy_finalizations','command_token','foreign']
])('rejects forged taxonomy %s %s',async(table,column,value)=>{
 const f=await fixture();expect(()=>revision(f,[first],(name,row)=>name===table?{...row,[column]:value}:row)).toThrow();
 expect(f.db.prepare('SELECT * FROM analysis_failure_taxonomies').all()).toEqual([]);
});
it.each(['analysis_failure_taxonomy_revisions','analysis_failure_codes','analysis_failure_taxonomy_revision_codes','analysis_taxonomy_finalizations'])('rejects missing taxonomy bundle %s',async table=>{
 const f=await fixture();expect(()=>revision(f,[first],(name,row)=>name===table?null:row)).toThrow();
 expect(f.db.prepare('SELECT * FROM analysis_failure_taxonomies').all()).toEqual([]);
});
it('rejects omitted prior codes, changed retirement text, reactivation and duplicate active labels',async()=>{
 const f=await fixture();revision(f);
 expect(()=>revision(f,[{kind:'new',clientToken:'different',label:'Different',definition:'Different failure'}])).toThrow(/retain codes/);
 expect(()=>revision(f,[{...existing('retired'),label:'Rewritten'}])).toThrow(/freeze retirement/);
 expect(()=>revision(f,[existing(),{...first,clientToken:'duplicate'}])).toThrow(/UNIQUE/);
 revision(f,[existing('retired')]);
 expect(()=>revision(f,[existing()])).toThrow(/freeze retirement/);
 expect(()=>revision(f,[{...existing('retired'),definition:'Rewritten'}])).toThrow(/freeze retirement/);
});
it('rejects late code append after finalization even inside the creating command',async()=>{
 const f=await fixture();expect(()=>revision(f,[first],undefined,c=>c.db.exec("INSERT INTO analysis_failure_codes SELECT 'extra',project_id,taxonomy_id,created_in_revision_id,'extra',content_digest,created_by_user_id,created_by_subject_id,created_at FROM analysis_failure_codes"))).toThrow(/creating revision command/);
 expect(f.db.prepare('SELECT * FROM analysis_failure_taxonomies').all()).toEqual([]);
});
it('rechecks owner membership for each new failure code inside the same command',async()=>{
 const f=await fixture();expect(()=>revision(f,[first],(table,row,c)=>{
  if(table==='analysis_failure_codes')c.db.prepare("UPDATE project_members SET role='member' WHERE project_id=? AND user_id=?").run(f.projectId,f.userId);
  return row;
 })).toThrow(/exact current owner/);
 expect(f.db.prepare('SELECT * FROM analysis_failure_taxonomies').all()).toEqual([]);
 expect(f.db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(f.projectId,f.userId)?.role).toBe('owner');
});
