import {randomUUID} from 'node:crypto';
import {EVALUATOR_EXECUTION_AUTHORIZATION_VERSION} from '@rubrist/shared';
import type {EvaluatorExecutionAuthorizationInput} from '../../evaluator-lifecycle/repository.js';
import {EvaluatorLifecycleRepositoryError} from '../../evaluator-lifecycle/repository.js';
import {repoError} from '../../evaluator-lifecycle/storage-values.js';
import {evaluatorExecutionAuthorizationDigest} from '../../lib/evaluator-lifecycle.js';
import type {SqliteCommandContext} from './command-context.js';
export function authorizeLifecycleExecution(c:SqliteCommandContext,input:EvaluatorExecutionAuthorizationInput,id=`eauth_${randomUUID()}`){
 try{
  const head=c.db.prepare('SELECT * FROM evaluator_lifecycle_contexts WHERE project_id=? AND skill_version_id=?').get(input.projectId,input.skillVersionId);
  if(!head)throw repoError('not_found','Evaluator version not found');
  const lifecycleEventId=head.lifecycle_event_id==null?null:String(head.lifecycle_event_id),calibrationArtifactId=head.calibration_artifact_id==null?null:String(head.calibration_artifact_id);
  const digest=evaluatorExecutionAuthorizationDigest({...input,lifecycleEventId,calibrationArtifactId});
  // BEFORE INSERT guards run even for an idempotent replay, rechecking eligibility.
  c.db.prepare('INSERT INTO evaluator_execution_authorizations VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,idempotency_key) DO NOTHING').run(id,EVALUATOR_EXECUTION_AUTHORIZATION_VERSION,input.projectId,input.skillVersionId,input.context,lifecycleEventId,calibrationArtifactId,input.resourceKind,input.resourceId,input.idempotencyKey,digest,c.timestamp);
  if(c.db.prepare('SELECT content_digest FROM evaluator_execution_authorizations WHERE project_id=? AND idempotency_key=?').get(input.projectId,input.idempotencyKey)?.content_digest!==digest)throw repoError('idempotency_conflict','Execution authorization idempotency key was reused');
 }catch(error){
  if(error instanceof EvaluatorLifecycleRepositoryError)throw error;
  if(((Number((error as {errcode?:number}).errcode)||0)&255)===19)throw repoError('execution_forbidden','Evaluator version is not authorized for the requested execution context');
  throw error;
 }
}
