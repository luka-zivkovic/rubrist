import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { sqliteCommand, type SqliteCommandContext } from '../../src/storage/sqlite/command-context.js';
import * as taxonomy from '../../src/lib/analysis-study.js';
type Fixture={db:DatabaseSync;projectId:string;userId:string};
type Row=Record<string,SQLInputValue>;
export type Code={kind:'new';clientToken:string;label:string;definition:string}|{kind:'existing';codeId:string;label:string;definition:string;status:'active'|'retired'};
type Hook=(table:string,row:Row,c:SqliteCommandContext)=>Row|null;
export const first:Extract<Code,{kind:'new'}>={kind:'new',clientToken:'first',label:'Missing context',definition:'Answer omits required context'};
export function revision(f:Fixture,codes:Code[]=[first],hook:Hook=(_,r)=>r,after?:(c:SqliteCommandContext)=>void){
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
export const existing=(status:'active'|'retired'='active'):Code=>({kind:'existing',codeId:'revision-1-first',label:first.label,definition:first.definition,status});
