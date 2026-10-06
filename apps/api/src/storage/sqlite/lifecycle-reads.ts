import type {DatabaseSync} from 'node:sqlite';
import {EvaluatorCandidateCreateResultSchema,EvaluatorLifecycleProjectionSchema,SkillSchema,type EvaluatorLifecycleProjection,type EvaluatorLifecycleListPage,type EvaluatorLifecycleTransitionResult} from '@rubrist/shared';
import {rowToLifecycle,rowToEvent,decodeLifecycleCursor,encodeLifecycleCursor} from '../../evaluator-lifecycle/storage-values.js';
import type {EvaluatorLifecyclePageInput} from '../../evaluator-lifecycle/repository.js';
import {sqliteSkillVersion} from './definition-commands.js';

type Row=Record<string,any>;
// Read sequence as text: SQLite INTEGER exceeds JavaScript's exact integer range.
export function lifecycleHead(db:DatabaseSync,lifecycleId:string):Row|null {
 return db.prepare('SELECT *,CAST(sequence AS TEXT) sequence FROM evaluator_lifecycle_heads WHERE lifecycle_id=?').get(lifecycleId)??null;
}
export function loadLifecycleProjection(db:DatabaseSync,projectId:string,skillVersionId:string):EvaluatorLifecycleProjection|null {
 const lifecycle=db.prepare('SELECT * FROM evaluator_lifecycles WHERE project_id=? AND skill_version_id=?').get(projectId,skillVersionId);
 if(!lifecycle)return null;
 const head=lifecycleHead(db,String(lifecycle.id));if(!head)return null;
 const currentEvent=rowToEvent(head);
 const admissibility=String(db.prepare('SELECT admissibility FROM evaluator_lifecycle_admissibility WHERE lifecycle_id=?').get(String(lifecycle.id))!.admissibility) as EvaluatorLifecycleProjection['currentCalibrationAdmissibility'];
 const reasons:EvaluatorLifecycleProjection['implicitDenialReasons']=[];
 if(currentEvent.state!=='active')reasons.push('not_active');
 if(currentEvent.state==='active'&&admissibility==='revoked')reasons.push('calibration_revoked');
 if(currentEvent.state==='active'&&admissibility==='unknown')reasons.push('calibration_status_unknown');
 if(currentEvent.state==='active'&&currentEvent.activationEvidence===null)reasons.push('activation_evidence_mismatch');
 return EvaluatorLifecycleProjectionSchema.parse({lifecycle:rowToLifecycle(lifecycle),currentEvent,currentCalibrationAdmissibility:admissibility,implicitExecutionAllowed:currentEvent.state==='active'&&admissibility==='admissible'&&reasons.length===0,implicitDenialReasons:reasons});
}
export function listLifecycleProjections(db:DatabaseSync,projectId:string,input:EvaluatorLifecyclePageInput):EvaluatorLifecycleListPage {
 const cursor=input.cursor===null?null:decodeLifecycleCursor(input.cursor);
 const rows=db.prepare(`SELECT skill_version_id,id,substr(created_at,1,23)||'000Z' cursor_created_at FROM evaluator_lifecycles
 WHERE project_id=? AND (? IS NULL OR (substr(created_at,1,23)||'000Z',id)<(?,?)) ORDER BY created_at DESC,id DESC LIMIT ?`).all(projectId,cursor?.createdAt??null,cursor?.createdAt??null,cursor?.id??null,input.limit+1);
 const page=rows.slice(0,input.limit),last=page.at(-1);
 return {items:page.map(row=>loadLifecycleProjection(db,projectId,String(row.skill_version_id))).filter((p):p is EvaluatorLifecycleProjection=>p!==null),nextCursor:rows.length>input.limit&&last?encodeLifecycleCursor({createdAt:String(last.cursor_created_at),id:String(last.id)}):null,totalCount:String(db.prepare('SELECT CAST(count(*) AS TEXT) n FROM evaluator_lifecycles WHERE project_id=?').get(projectId)!.n)};
}
export function loadLifecycleCandidateResult(db:DatabaseSync,projectId:string,skillVersionId:string,replayed:boolean){
 const version=db.prepare('SELECT * FROM skill_versions WHERE project_id=? AND id=?').get(projectId,skillVersionId) as Row|undefined;
 const projection=loadLifecycleProjection(db,projectId,skillVersionId);
 if(!version||!projection)throw new Error('Candidate lifecycle result vanished');
 const row=db.prepare('SELECT s.*,u.name owner_name,u.email owner_email FROM skills s LEFT JOIN "user" u ON u.id=s.owner_user_id WHERE s.project_id=? AND s.id=?').get(projectId,version.skill_id) as Row;
 const statuses={candidate:'calibrating',active:'production',needs_review:'needs_review',retired:'deprecated'} as const;
 const status=statuses[projection.currentEvent.state];
 const skill=SkillSchema.parse({id:row.id,projectId:row.project_id,criterionId:row.criterion_id,name:row.name,description:row.description,ownerName:row.owner_name??row.owner_email??row.owner_user_id??'Owner',status,isStarter:Boolean(row.is_starter),currentVersion:sqliteSkillVersion({...version,status})});
 return EvaluatorCandidateCreateResultSchema.parse({skill,projection,replayed});
}
export function loadLifecycleTransitionResult(db:DatabaseSync,projectId:string,eventRow:Row,replayed:boolean):EvaluatorLifecycleTransitionResult {
 const event=rowToEvent(eventRow),projection=loadLifecycleProjection(db,projectId,event.skillVersionId);
 if(!projection)throw new Error('Lifecycle transition projection vanished');
 const replaced=event.activationBundleId?db.prepare('SELECT *,CAST(sequence AS TEXT) sequence FROM evaluator_lifecycle_events WHERE project_id=? AND activation_bundle_id=? AND id<>? ORDER BY sequence DESC LIMIT 1').get(projectId,event.activationBundleId,event.id):null;
 return {projection,event,replacedEvent:replaced?rowToEvent(replaced):null,replayed};
}
