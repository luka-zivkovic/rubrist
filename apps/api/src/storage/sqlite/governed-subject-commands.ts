import type { DatabaseSync } from 'node:sqlite';
import type { GovernedReviewActor,GovernedReviewRepository } from '../../governed-review/repository.js';
import { GovernedReviewForbiddenError } from '../../governed-review/errors.js';
import { stableId } from '../../governed-review/storage-values.js';
import { governedJsonTextDigest } from './governed-json-text.js';
import { sqliteCommand } from './command-context.js';

export function governedReviewAccess(db:DatabaseSync,actor:GovernedReviewActor,owner=false):void {
 const role=db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(actor.projectId,actor.userId)?.role;
 if((role!=='owner'&&role!=='member')||(owner&&(role!=='owner'||actor.projectRole!=='owner')))throw new GovernedReviewForbiddenError();
}
export function governedReviewSubject(db:DatabaseSync,projectId:string,userId:string,stamp:string):string {
 if(!db.prepare("SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND role IN ('owner','member')").get(projectId,userId))throw new GovernedReviewForbiddenError();
 const id=stableId('grs',projectId,userId);
 db.prepare('INSERT INTO governed_reviewer_subjects(id,project_id,account_user_id,subject_digest,created_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id,account_user_id) DO NOTHING').run(id,projectId,userId,governedJsonTextDigest('governed-reviewer-subject/v1',JSON.stringify({projectId,subjectId:id})),stamp);
 return String(db.prepare('SELECT id FROM governed_reviewer_subjects WHERE project_id=? AND account_user_id=?').get(projectId,userId)!.id);
}
export function sqliteGovernedSubjectCommands(db:DatabaseSync,clock=Date.now){return {
 governedAssignableSubjects(...[actor]:Parameters<GovernedReviewRepository['listAssignableSubjects']>){return sqliteCommand(db,c=>{
  governedReviewAccess(db,actor,true);
  const rows=db.prepare('SELECT pm.user_id,pm.role,u.name,u.email FROM project_members pm JOIN "user" u ON u.id=pm.user_id WHERE pm.project_id=? AND pm.role IN (\'owner\',\'member\') ORDER BY lower(coalesce(u.name,u.email,pm.user_id)),pm.user_id').all(actor.projectId);
  return rows.map(row=>({subjectId:governedReviewSubject(db,actor.projectId,String(row.user_id),c.timestamp),userId:String(row.user_id),name:row.name===null?null:String(row.name),email:row.email===null?null:String(row.email),projectRole:row.role==='owner'?'owner' as const:'member' as const}));
 },clock);}
};}
