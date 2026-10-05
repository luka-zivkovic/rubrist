import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AnalysisFailureTaxonomyCreateInputSchema,AnalysisTaxonomyRevisionCreateInputSchema,AnalysisTaxonomyRevisionResultSchema,type AnalysisTaxonomyRevisionCreateInput } from '@rubrist/shared';
import type { AnalysisStudyRepository,AnalysisStudyActor } from '../../analysis-study/repository.js';
import * as evidence from '../../lib/analysis-study.js';
import { studyAccess,studySubject,studyWrite,studyError } from './study-support.js';
import { taxonomyArtifact,taxonomyRevisionProjection } from './study-projections.js';
import { insertStudyRecord } from './study-write.js';
import type { SqliteCommandContext } from './command-context.js';
type Args<K extends keyof AnalysisStudyRepository>=Parameters<AnalysisStudyRepository[K]>;

export function sqliteStudyTaxonomyCommands(db:DatabaseSync,clock=Date.now){
 const write=<T>(body:(c:SqliteCommandContext)=>T)=>studyWrite(db,body,clock);
 const result=(projectId:string,taxonomyId:string,revisionId:string|null,replayed:boolean)=>AnalysisTaxonomyRevisionResultSchema.parse({taxonomy:taxonomyArtifact(db,projectId,taxonomyId),revision:taxonomyRevisionProjection(db,projectId,taxonomyId,revisionId),replayed});
 function revision(c:SqliteCommandContext,actor:AnalysisStudyActor,subjectId:string,taxonomyId:string,revisionId:string,input:{idempotencyKey:string;reason:string;codes:AnalysisTaxonomyRevisionCreateInput['codes']},requestPayload:string,requestDigest:string,previous:ReturnType<typeof taxonomyRevisionProjection>){
  const known=new Set(previous?.codes.map(code=>code.codeId)??[]);
  if(input.codes.some(code=>code.kind==='existing'&&!known.has(code.codeId)))throw studyError('analysis_taxonomy_conflict','Taxonomy successor named an unknown stable code');
  const entries=input.codes.map((code,position)=>({id:'aftrc_'+randomUUID(),projectId:actor.projectId,taxonomyId,taxonomyRevisionId:revisionId,codeId:code.kind==='new'?'afc_'+randomUUID():code.codeId,position,label:code.label,definition:code.definition,status:code.kind==='new'?'active' as const:code.status,createdAt:c.timestamp}));
  const codes=entries.map(entry=>({...entry,entryDigest:evidence.analysisTaxonomyRevisionCodeEntryDigest(entry)}));
  const contentDigest=evidence.analysisTaxonomyContentDigest(codes.map(code=>code.entryDigest));
  const basis={taxonomyId,sequence:(previous?.revision.sequence??0)+1,predecessorRevisionId:previous?.revision.id??null,predecessorRevisionDigest:previous?.revision.revisionDigest??null,reason:input.reason,contentDigest};
  const artifact={id:revisionId,projectId:actor.projectId,...basis,codeCount:codes.length,revisionDigest:evidence.analysisTaxonomyRevisionDigest(basis),createdByUserId:actor.userId,createdBySubjectId:subjectId,idempotencyKey:input.idempotencyKey,requestDigest,createdAt:c.timestamp};
  if(previous){
   const taxonomy=taxonomyArtifact(db,actor.projectId,taxonomyId)!;
   try{evidence.assertAnalysisTaxonomyRevision(taxonomy,artifact,codes,previous);}catch{throw studyError('analysis_taxonomy_conflict','Taxonomy successor conflicts with retained stable codes');}
  }
  insertStudyRecord(c,'analysis_failure_taxonomy_revisions',{...artifact,requestPayload,createdCommandToken:c.token});
  for(const [position,entry] of codes.entries()){
   const command=input.codes[position]!;
   if(command.kind==='new')insertStudyRecord(c,'analysis_failure_codes',{id:entry.codeId,projectId:actor.projectId,taxonomyId,createdInRevisionId:revisionId,clientToken:command.clientToken,contentDigest:evidence.analysisFailureCodeContentDigest({projectId:actor.projectId,taxonomyId,createdInRevisionId:revisionId,codeId:entry.codeId}),createdByUserId:actor.userId,createdBySubjectId:subjectId,createdAt:c.timestamp});
   insertStudyRecord(c,'analysis_failure_taxonomy_revision_codes',entry);
  }
  insertStudyRecord(c,'analysis_taxonomy_finalizations',{revisionId,projectId:actor.projectId,commandToken:c.token});
  return result(actor.projectId,taxonomyId,revisionId,false);
 }
 return {
  studyTaxonomyCreate(...[actor,raw]:Args<'createTaxonomy'>){const input=AnalysisFailureTaxonomyCreateInputSchema.parse(raw);return write(c=>{
   studyAccess(db,actor,true);const subjectId=studySubject(db,c,actor),requestDigest=evidence.analysisFailureTaxonomyRequestDigest(actor.projectId,input);
   const existing=db.prepare('SELECT id,idempotency_key,request_digest FROM analysis_failure_taxonomies WHERE project_id=?').get(actor.projectId);
   if(existing){if(existing.idempotency_key!==input.idempotencyKey)throw studyError('analysis_taxonomy_conflict','Project already has its single failure taxonomy');if(existing.request_digest!==requestDigest)throw studyError('analysis_study_idempotency_conflict','Taxonomy key was reused with different input');return result(actor.projectId,String(existing.id),null,true);}
   const taxonomyId='aft_'+randomUUID(),revisionId='aftr_'+randomUUID(),{idempotencyKey,...request}=input,requestPayload=JSON.stringify(request);
   const basis={projectId:actor.projectId,contractVersion:'analysis-taxonomy/v1' as const,name:input.name,description:input.description};
   insertStudyRecord(c,'analysis_failure_taxonomies',{id:taxonomyId,...basis,idempotencyKey,requestPayload,requestDigest,contentDigest:evidence.analysisFailureTaxonomyContentDigest(basis),createdByUserId:actor.userId,createdBySubjectId:subjectId,createdAt:c.timestamp,createdCommandToken:c.token,initialRevisionId:revisionId});
   return revision(c,actor,subjectId,taxonomyId,revisionId,input,requestPayload,requestDigest,null);
  });},
  studyTaxonomyRevise(...[actor,taxonomyId,raw]:Args<'createTaxonomyRevision'>){const input=AnalysisTaxonomyRevisionCreateInputSchema.parse(raw);return write(c=>{
   studyAccess(db,actor,true);const subjectId=studySubject(db,c,actor),requestDigest=evidence.analysisTaxonomyRevisionRequestDigest(taxonomyId,input);
   if(!taxonomyArtifact(db,actor.projectId,taxonomyId))throw studyError('analysis_taxonomy_not_found','Failure taxonomy not found');
   const prior=db.prepare('SELECT id,request_digest FROM analysis_failure_taxonomy_revisions WHERE project_id=? AND taxonomy_id=? AND idempotency_key=?').get(actor.projectId,taxonomyId,input.idempotencyKey);
   if(prior){if(prior.request_digest!==requestDigest)throw studyError('analysis_study_idempotency_conflict','Taxonomy revision key was reused with different input');return result(actor.projectId,taxonomyId,String(prior.id),true);}
   const previous=taxonomyRevisionProjection(db,actor.projectId,taxonomyId);
   if(!previous||previous.revision.id!==input.expectedPredecessorRevisionId||previous.revision.revisionDigest!==input.expectedPredecessorRevisionDigest||previous.revision.sequence!==input.expectedPredecessorSequence)throw studyError('analysis_taxonomy_conflict','Taxonomy revision compare-and-swap head mismatch');
   const {idempotencyKey:_key,...request}=input;
   return revision(c,actor,subjectId,taxonomyId,'aftr_'+randomUUID(),input,JSON.stringify(request),requestDigest,previous);
  });}
 };
}
