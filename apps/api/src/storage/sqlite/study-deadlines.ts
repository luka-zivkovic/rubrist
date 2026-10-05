import type { DatabaseSync } from 'node:sqlite';
import { sqliteCommand, type SqliteCommandContext } from './command-context.js';

const dueStudy = `SELECT s.id,s.project_id FROM analysis_studies s
 JOIN analysis_study_events opened ON opened.study_id=s.id AND opened.event_type='coding_opened'
 LEFT JOIN analysis_study_deadline_retry_state retry ON retry.study_id=s.id AND retry.project_id=s.project_id
 WHERE opened.stopping_rule='server_deadline' AND opened.close_at<=?
 AND (SELECT to_state FROM analysis_study_events WHERE study_id=s.id ORDER BY version DESC LIMIT 1)='coding_open'`;

/** Sample the persisted monotonic server clock inside the serialized command. */
export function dueStudyCandidates(db:DatabaseSync,limit:number,clock=Date.now):Array<{projectId:string;studyId:string}> {
 if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('deadline batch limit is invalid');
 return sqliteCommand(db,c=>c.db.prepare(`${dueStudy}
  AND (retry.study_id IS NULL OR retry.next_retry_at<=?)
  ORDER BY opened.close_at,governed_utf16_sort_key_v1(s.id) LIMIT ?`)
  .all(c.timestamp,c.timestamp,limit).map(row=>({projectId:String(row.project_id),studyId:String(row.id)})),clock);
}

/** Called after a failed closure transaction has rolled back; never retain error details. */
export function recordStudyDeadlineFailure(db:DatabaseSync,projectId:string,studyId:string,clock=Date.now):void {
 sqliteCommand(db,c=>{
  if(!c.db.prepare(`${dueStudy} AND s.project_id=? AND s.id=?`).get(c.timestamp,projectId,studyId))return;
  const previous=c.db.prepare('SELECT failure_count FROM analysis_study_deadline_retry_state WHERE project_id=? AND study_id=?').get(projectId,studyId);
  const count=Math.min(Number(previous?.failure_count??0)+1,1_000_000);
  const next=new Date(c.milliseconds+Math.min(3600,5*2**Math.min(count-1,10))*1000).toISOString();
  c.db.prepare(`INSERT INTO analysis_study_deadline_retry_state
   (project_id,study_id,failure_count,last_error_code,last_failed_at,next_retry_at,updated_at)
   VALUES(?,?,?,'closure_failed',?,?,?) ON CONFLICT(study_id) DO UPDATE SET
   failure_count=excluded.failure_count,last_failed_at=excluded.last_failed_at,
   next_retry_at=excluded.next_retry_at,updated_at=excluded.updated_at`)
   .run(projectId,studyId,count,c.timestamp,next,c.timestamp);
 },clock);
}

/** Clear in the transaction which successfully materialized or observed closure. */
export function clearStudyDeadlineFailure(c:SqliteCommandContext,projectId:string,studyId:string):void {
 c.db.prepare('DELETE FROM analysis_study_deadline_retry_state WHERE project_id=? AND study_id=?').run(projectId,studyId);
}
