import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SQLInputValue } from 'node:sqlite';
import { openSqlite } from '@rubrist/db/sqlite';
import { createUnseededSqliteRuntime } from './helpers/sqlite.js';
import { sqliteCommand, type SqliteCommandContext } from '../src/storage/sqlite/command-context.js';
import { sqliteCommands } from '../src/storage/sqlite/commands.js';
import * as taxonomy from '../src/lib/analysis-study.js';
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
type Fixture=Awaited<ReturnType<typeof fixture>>;
type Row=Record<string,SQLInputValue>;
type Code={kind:'new';clientToken:string;label:string;definition:string}|{kind:'existing';codeId:string;label:string;definition:string;status:'active'|'retired'};
type Hook=(table:string,row:Row,c:SqliteCommandContext)=>Row|null;
const first:Code={kind:'new',clientToken:'first',label:'Missing context',definition:'Answer omits required context'};
function revision(f:Fixture,codes:Code[]=[first],hook:Hook=(_,r)=>r,after?:(c:SqliteCommandContext)=>void){
 return sqliteCommand(f.db,c=>{
  const insert=(table:string,row:Row)=>{const r=hook(table,row,c);if(!r)return;const keys=Object.keys(r);c.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(r));};
  const head=f.db.prepare('SELECT * FROM analysis_failure_taxonomy_revisions ORDER BY sequence DESC LIMIT 1').get();
  const sequence=Number(head?.sequence??0)+1,id='revision-'+sequence,reason='Taxonomy revision '+sequence;
  const request=head?{expectedPredecessorRevisionId:String(head.id),expectedPredecessorRevisionDigest:String(head.revision_digest),expectedPredecessorSequence:Number(head.sequence),reason,codes}:{name:'Failures',description:'Human authored failure taxonomy',reason,codes};
  const requestDigest=head?taxonomy.analysisTaxonomyRevisionRequestDigest('taxonomy',{...request,idempotencyKey:id} as never):taxonomy.analysisFailureTaxonomyRequestDigest(f.projectId,{...request,idempotencyKey:id} as never);
  if(!head){
   const basis={projectId:f.projectId,contractVersion:'analysis-taxonomy/v1' as const,name:'Failures',description:'Human authored failure taxonomy'};
   insert('analysis_failure_taxonomies',{id:'taxonomy',project_id:f.projectId,contract_version:basis.contractVersion,name:basis.name,description:basis.description,idempotency_key:id,request_payload:JSON.stringify(request),request_digest:requestDigest,content_digest:taxonomy.analysisFailureTaxonomyContentDigest(basis),created_by_user_id:f.userId,created_by_subject_id:'subject',created_at:c.timestamp,created_command_token:c.token,initial_revision_id:id});
  }
  const entries=codes.map((code,position)=>({taxonomyId:'taxonomy',taxonomyRevisionId:id,codeId:code.kind==='new'?id+'-'+code.clientToken:code.codeId,position,label:code.label,definition:code.definition,status:code.kind==='new'?'active' as const:code.status}));
  const entryDigests=entries.map(taxonomy.analysisTaxonomyRevisionCodeEntryDigest),contentDigest=taxonomy.analysisTaxonomyContentDigest(entryDigests);
  const revisionDigest=taxonomy.analysisTaxonomyRevisionDigest({taxonomyId:'taxonomy',sequence,predecessorRevisionId:head?String(head.id):null,predecessorRevisionDigest:head?String(head.revision_digest):null,reason,contentDigest});
  insert('analysis_failure_taxonomy_revisions',{id,project_id:f.projectId,taxonomy_id:'taxonomy',sequence,predecessor_revision_id:head?.id??null,predecessor_revision_digest:head?.revision_digest??null,code_count:codes.length,reason,content_digest:contentDigest,revision_digest:revisionDigest,created_by_user_id:f.userId,created_by_subject_id:'subject',idempotency_key:id,request_payload:JSON.stringify(request),request_digest:requestDigest,created_at:c.timestamp,created_command_token:c.token});
  entries.forEach((e,position)=>{
   const code=codes[position]!;
   if(code.kind==='new')insert('analysis_failure_codes',{id:e.codeId,project_id:f.projectId,taxonomy_id:'taxonomy',created_in_revision_id:id,client_token:code.clientToken,content_digest:taxonomy.analysisFailureCodeContentDigest({projectId:f.projectId,taxonomyId:'taxonomy',createdInRevisionId:id,codeId:e.codeId}),created_by_user_id:f.userId,created_by_subject_id:'subject',created_at:c.timestamp});
   insert('analysis_failure_taxonomy_revision_codes',{id:id+'-entry-'+position,project_id:f.projectId,taxonomy_id:'taxonomy',taxonomy_revision_id:id,code_id:e.codeId,position,label:e.label,definition:e.definition,status:e.status,entry_digest:entryDigests[position]!,created_at:c.timestamp});
  });
  insert('analysis_taxonomy_finalizations',{revision_id:id,project_id:f.projectId,command_token:c.token});after?.(c);return {id,entries,revisionDigest};
 });
}
const existing=(status:'active'|'retired'='active'):Code=>({kind:'existing',codeId:'revision-1-first',label:first.label,definition:first.definition,status});
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
