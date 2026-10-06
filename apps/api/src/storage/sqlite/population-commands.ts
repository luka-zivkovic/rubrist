import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { AnalysisPopulationCreateResultSchema, AnalysisPopulationDetailSchema, AnalysisPopulationSummariesPageSchema, AnalysisPopulationMembersPageSchema, AnalysisPopulationSelectedItemsPageSchema, AnalysisPopulationExclusionsPageSchema, AnalysisPopulationOverlapsPageSchema, DatasetRevisionPayloadSnapshotSchema } from '@rubrist/shared';
import { AnalysisPopulationRepositoryError, type AnalysisPopulationRepository } from '../../analysis-population/repository.js';
import { sqliteCommand } from './command-context.js';
import { buildSqlitePopulation, requirePopulationAccess, populationSubject } from './population-build.js';
import * as values from './population-values.js';
type Args<K extends keyof AnalysisPopulationRepository>=Parameters<AnalysisPopulationRepository[K]>;
export function sqlitePopulationCommands(db:DatabaseSync){
 const one=(sql:string,...args:SQLInputValue[])=>db.prepare(sql).get(...args);
 const all=(sql:string,...args:SQLInputValue[])=>db.prepare(sql).all(...args);
 function summary(projectId:string,populationId:string){const row=one(values.summarySelect()+' WHERE population.project_id=? AND population.id=?',projectId,populationId);return row?values.rowToSummary(row):null;}
 function limit(value:number){if(!Number.isSafeInteger(value)||value<1||value>1000)throw new AnalysisPopulationRepositoryError('analysis_population_invalid_cursor','Invalid population page limit');return value;}
 function write<T>(fn:Parameters<typeof sqliteCommand<T>>[1]):T{try{return sqliteCommand(db,fn);}catch(error){
  if(error instanceof AnalysisPopulationRepositoryError)throw error;
  // Map only busy/locked and constraint/guard failures, as PostgreSQL maps
  // only serialization and 23514/23503/55000. I/O, corruption and other
  // engine errors stay unmapped server errors with no client-facing message.
  const message=error instanceof Error?error.message:String(error),code=(error as {code?:string})?.code,primary=(Number((error as {errcode?:number})?.errcode)||0)&255;
  if(code==='ERR_SQLITE_ERROR'&&(primary===5||primary===6))throw new AnalysisPopulationRepositoryError('analysis_population_state_conflict','Analysis population serialization conflict; retry the same idempotency key');
  if(code==='ERR_SQLITE_ERROR'&&primary===19)throw new AnalysisPopulationRepositoryError('analysis_population_revision_conflict',message.slice(0,2000));throw error;
 }}
 const commands={
  populationCreate(...[actor,input]:Args<'createPopulation'>){return write(context=>{const created=buildSqlitePopulation(db,context,actor,input);return AnalysisPopulationCreateResultSchema.parse({...summary(actor.projectId,created.populationId),reusedPopulation:created.reused,reusedDraw:created.reused});});},
  populationList(...[access,page]:Args<'listPopulations'>){requirePopulationAccess(db,access);const size=limit(page.limit),cursor=values.decodeCursor(page.cursor,'population list','chronological');
   const rows=all(values.summarySelect()+' WHERE population.project_id=? AND (? IS NULL OR (population.created_at,governed_utf16_sort_key_v1(population.id))<(?,governed_utf16_sort_key_v1(?))) ORDER BY population.created_at DESC,governed_utf16_sort_key_v1(population.id) DESC LIMIT ?',access.projectId,cursor.createdAt??null,cursor.createdAt??null,cursor.id??'',size+1);
   const last=rows[size-1];return AnalysisPopulationSummariesPageSchema.parse({items:rows.slice(0,size).map(values.rowToSummary),totalCount:String(one('SELECT count(*) n FROM analysis_populations WHERE project_id=?',access.projectId)!.n),nextCursor:rows.length>size?values.encodeCursor({createdAt:String(last!.population_created_at),id:String(last!.population_id)}):null});
  },
  populationGet(...[access,populationId]:Args<'getPopulation'>){requirePopulationAccess(db,access);const found=summary(access.projectId,populationId);if(!found)return null;
   const count=one('SELECT count(DISTINCT b.population_id) n FROM analysis_population_members a JOIN analysis_population_members b ON b.project_id=a.project_id AND b.case_id=a.case_id AND b.population_id<>a.population_id WHERE a.project_id=? AND a.population_id=?',access.projectId,populationId);
   return AnalysisPopulationDetailSchema.parse({...found,overlapCount:String(count!.n)});
  },
  populationMembers(...[access,populationId,page]:Args<'listMembers'>){requirePopulationAccess(db,access);const population=one('SELECT population_size FROM analysis_populations WHERE project_id=? AND id=?',access.projectId,populationId);if(!population)return null;
   const size=limit(page.limit),cursor=values.decodeCursor(page.cursor,'population members','position');
   const rows=all('SELECT * FROM analysis_population_members WHERE project_id=? AND population_id=? AND position>? ORDER BY position LIMIT ?',access.projectId,populationId,BigInt(cursor.position??'-1'),size+1);
   return AnalysisPopulationMembersPageSchema.parse({items:rows.slice(0,size).map(values.rowToMember),totalCount:Number(population.population_size),nextCursor:rows.length>size?values.encodeCursor({position:String(rows[size-1]!.position)}):null});
  },
  populationSelections(...[access,populationId,page]:Args<'listSelections'>){requirePopulationAccess(db,access);const draw=one('SELECT id,fixed_budget FROM analysis_population_draws WHERE project_id=? AND population_id=?',access.projectId,populationId);if(!draw)return null;
   const size=limit(page.limit),cursor=values.decodeCursor(page.cursor,'population selections','position');
   const rows=all('SELECT * FROM analysis_population_draw_items WHERE project_id=? AND draw_id=? AND position>? ORDER BY position LIMIT ?',access.projectId,draw.id!,BigInt(cursor.position??'-1'),size+1);
   return AnalysisPopulationSelectedItemsPageSchema.parse({items:rows.slice(0,size).map(values.rowToSelection),totalCount:Number(draw.fixed_budget),nextCursor:rows.length>size?values.encodeCursor({position:String(rows[size-1]!.position)}):null});
  },
  populationExclusions(...[access,populationId,page]:Args<'listExclusions'>){requirePopulationAccess(db,access);const population=one('SELECT exclusion_count FROM analysis_populations WHERE project_id=? AND id=?',access.projectId,populationId);if(!population)return null;
   const size=limit(page.limit),cursor=values.decodeCursor(page.cursor,'population exclusions','position');
   const rows=all('SELECT * FROM analysis_population_exclusions WHERE project_id=? AND population_id=? AND position>? ORDER BY position LIMIT ?',access.projectId,populationId,BigInt(cursor.position??'-1'),size+1);
   return AnalysisPopulationExclusionsPageSchema.parse({items:rows.slice(0,size).map(values.rowToExclusion),totalCount:String(population.exclusion_count),nextCursor:rows.length>size?values.encodeCursor({position:String(rows[size-1]!.position)}):null});
  },
  populationOverlaps(...[access,populationId,page]:Args<'listOverlaps'>){requirePopulationAccess(db,access);if(!one('SELECT 1 FROM analysis_populations WHERE project_id=? AND id=?',access.projectId,populationId))return null;
   const size=limit(page.limit),cursor=values.decodeCursor(page.cursor,'population overlaps','chronological');
   const base=' FROM analysis_population_members target JOIN analysis_population_members shared ON shared.project_id=target.project_id AND shared.case_id=target.case_id AND shared.population_id<>target.population_id JOIN analysis_populations other ON other.id=shared.population_id AND other.project_id=shared.project_id JOIN analysis_population_draws draw ON draw.population_id=other.id WHERE target.project_id=? AND target.population_id=?';
   const rows=all('SELECT other.id population_id,other.population_size,count(DISTINCT target.case_id) overlap_count,other.frame_digest,draw.id draw_id,draw.draw_digest,other.window_start,other.window_end,other.created_at'+base+' GROUP BY other.id,draw.id HAVING (? IS NULL OR (other.created_at,governed_utf16_sort_key_v1(other.id))<(?,governed_utf16_sort_key_v1(?))) ORDER BY other.created_at DESC,governed_utf16_sort_key_v1(other.id) DESC LIMIT ?',access.projectId,populationId,cursor.createdAt??null,cursor.createdAt??null,cursor.id??'',size+1);
   const total=one('SELECT count(*) n FROM(SELECT other.id'+base+' GROUP BY other.id)',access.projectId,populationId);
   return AnalysisPopulationOverlapsPageSchema.parse({items:rows.slice(0,size).map(row=>({populationId:row.population_id,populationSize:row.population_size,overlapCount:row.overlap_count,frameDigest:row.frame_digest,drawId:row.draw_id,drawDigest:row.draw_digest,windowStart:row.window_start,windowEnd:row.window_end,createdAt:row.created_at})),totalCount:String(total!.n),nextCursor:rows.length>size?values.encodeCursor({createdAt:String(rows[size-1]!.created_at),id:String(rows[size-1]!.population_id)}):null});
  },
  populationSelectedContent(...[access,populationId,drawPosition]:Args<'getSelectedContent'>){return write(context=>{
   requirePopulationAccess(db,access);
   if(!Number.isSafeInteger(drawPosition)||drawPosition<0)return null;
   const row=one(`SELECT p.dataset_revision_id,s.member_id,s.revision_item_id,s.case_id,s.position,i.input_digest,i.item_digest,i.payload_snapshot FROM analysis_populations p JOIN analysis_population_draws d ON d.population_id=p.id JOIN analysis_population_draw_items s ON s.draw_id=d.id JOIN dataset_revision_items i ON i.id=s.revision_item_id AND i.project_id=p.project_id AND i.revision_id=p.dataset_revision_id WHERE p.project_id=? AND p.id=? AND s.position=?`,access.projectId,populationId,drawPosition);if(!row)return null;
   const subjectId=populationSubject(db,access,context.timestamp);
   const key=`analysis-content-view:${row.dataset_revision_id}:${subjectId}`;
   db.prepare(`INSERT INTO dataset_exposure_events(id,project_id,revision_id,revision_item_id,kind,exposure_class,activity,subject_kind,subject_id,actor_user_id,evidence_ref_kind,evidence_ref_id,reason,details,idempotency_key,occurred_at) VALUES(?,?,?,NULL,'human_access','development','content_view','person',?,?,'analysis_population',?,'Governed Analyze population content view',?,?,?) ON CONFLICT(project_id,idempotency_key) DO NOTHING`).run(`dse_${randomUUID()}`,access.projectId,row.dataset_revision_id!,subjectId,access.userId,populationId,JSON.stringify({contract:'rubrist/analysis-population-content-view/v1',populationId}),key,context.timestamp);
   const event=one('SELECT * FROM dataset_exposure_events WHERE project_id=? AND idempotency_key=?',access.projectId,key);
   if(!event||event.revision_id!==row.dataset_revision_id||event.revision_item_id!==null||event.kind!=='human_access'||event.exposure_class!=='development'||event.activity!=='content_view'||event.subject_kind!=='person'||event.subject_id!==subjectId||event.actor_user_id!==access.userId||event.evidence_ref_kind!=='analysis_population'||event.evidence_ref_id!==populationId)throw new AnalysisPopulationRepositoryError('analysis_population_revision_conflict','Content exposure did not converge on the exact event');
   return {populationId,datasetRevisionId:String(row.dataset_revision_id),memberId:String(row.member_id),revisionItemId:String(row.revision_item_id),caseId:String(row.case_id),drawPosition:Number(row.position),inputDigest:String(row.input_digest),itemDigest:String(row.item_digest),payloadSnapshot:DatasetRevisionPayloadSnapshotSchema.parse(JSON.parse(String(row.payload_snapshot)))};
  });}
 };
 return commands;
}
