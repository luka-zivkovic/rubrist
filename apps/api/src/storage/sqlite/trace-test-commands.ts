import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { TraceTestSummarySchema, TraceTestRevisionSchema, TraceTestValidationSchema, TraceTestDetailSchema } from '@rubrist/shared';
import type { RubristRepository } from '../../repository.js';
import { traceTestValidationStatus, traceTestValidationDiagnostic } from '../../repository.js';
import { TraceTestNotFoundError, TraceTestSourceNotFoundError, TraceTestRevisionConflictError, TraceTestValidationNotReadyError } from '../../repository/errors.js';
import { redactNormalizedTracePayload } from '../../lib/redaction.js';
import { evaluationDatabase, camel, type Row } from './evaluation-values.js';
type Args<K extends keyof RubristRepository>=Parameters<RubristRepository[K]>;
const id=(prefix:string)=>`${prefix}_${randomUUID()}`;
const summary=(row:Row)=>TraceTestSummarySchema.parse({...camel(row),lifecycle:row.enabled_revision===null?'draft':'enabled',hasUnpublishedChanges:row.enabled_revision!==null&&row.current_revision!==row.enabled_revision});
const revision=(row:Row)=>TraceTestRevisionSchema.parse({...camel(row),...Object.fromEntries(['must_do','must_avoid','good_example','bad_example','checker','draft_provenance'].map(key=>[Object.keys(camel({[key]:null}))[0]!,JSON.parse(row[key])]))});
const validation=(row:Row)=>TraceTestValidationSchema.parse({...camel(row),badEvidence:JSON.parse(row.bad_evidence),goodEvidence:JSON.parse(row.good_evidence),evaluator:row.evaluator===null?null:JSON.parse(row.evaluator)});
export function sqliteTraceTestCommands(db:DatabaseSync) {
 const {one,all,run,transaction}=evaluationDatabase(db);
 function current(projectId:string,testId:string,expected:number) {
  const row=one('SELECT * FROM trace_tests WHERE project_id=? AND id=?',projectId,testId);
  if(!row)throw new TraceTestNotFoundError(testId);
  if(row.current_revision!==expected)throw new TraceTestRevisionConflictError(expected,row.current_revision);
  return row;
 }
 function draft(input:Args<'reviseTraceTest'>[0]|Args<'createTraceTest'>[0],testId:string,number:number,stamp:string) {
  run(`INSERT INTO trace_test_revisions(id,trace_test_id,project_id,revision,lifecycle,desired_behavior,scenario,expected_behavior,must_do,must_avoid,good_example,bad_example,checker,draft_provenance,created_by_user_id,created_at)
   VALUES(?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?)`,id('ttr'),testId,input.projectId,number,input.desiredBehavior,input.scenario,input.expectedBehavior,JSON.stringify(input.mustDo),JSON.stringify(input.mustAvoid),JSON.stringify(input.goodExample),JSON.stringify(input.badExample),JSON.stringify(input.checker),JSON.stringify(input.draftProvenance),input.createdByUserId??null,stamp);
 }
 const commands={
  createTraceTest(input:Args<'createTraceTest'>[0]) {return transaction(now=>{
   const source=one('SELECT c.*,rt.source_trace_id FROM cases c LEFT JOIN raw_traces rt ON rt.id=c.raw_trace_id AND rt.project_id=c.project_id WHERE c.project_id=? AND c.id=?',input.projectId,input.sourceCaseId);
   if(!source)throw new TraceTestSourceNotFoundError(input.sourceCaseId);
   const testId=id('tt'),stamp=new Date(now).toISOString();
   run('INSERT INTO trace_tests VALUES(?,?,?,?,?,?,?,1,NULL,?,?,?)',testId,input.projectId,input.sourceCaseId,input.sourceCaseId,source.source_trace_id??input.sourceCaseId,JSON.stringify(redactNormalizedTracePayload(JSON.parse(source.normalized_payload))),JSON.stringify(input.sourceScope),input.createdByUserId??null,stamp,stamp);
   draft(input,testId,1,stamp);return commands.getTraceTest(input.projectId,testId)!;
  });},
  listTraceTests(projectId:string,sourceCaseRef?:string) {return all('SELECT * FROM trace_tests WHERE project_id=? AND(? IS NULL OR source_case_ref=?) ORDER BY updated_at DESC,id DESC',projectId,sourceCaseRef??null,sourceCaseRef??null).map(summary);},
  getTraceTest(projectId:string,testId:string) {
   const row=one('SELECT * FROM trace_tests WHERE project_id=? AND id=?',projectId,testId);if(!row)return null;
   return TraceTestDetailSchema.parse({...summary(row),sourceSnapshot:JSON.parse(row.source_snapshot),sourceScope:JSON.parse(row.source_scope),createdByUserId:row.created_by_user_id,
    revisions:all('SELECT * FROM trace_test_revisions WHERE project_id=? AND trace_test_id=? ORDER BY revision',projectId,testId).map(revision),
    validations:all('SELECT * FROM trace_test_validations WHERE project_id=? AND trace_test_id=? ORDER BY created_at,id',projectId,testId).map(validation)});
  },
  reviseTraceTest(input:Args<'reviseTraceTest'>[0]) {return transaction(now=>{
   current(input.projectId,input.traceTestId,input.expectedRevision);const number=input.expectedRevision+1,stamp=new Date(now).toISOString();
   draft(input,input.traceTestId,number,stamp);run('UPDATE trace_tests SET current_revision=?,updated_at=? WHERE project_id=? AND id=?',number,stamp,input.projectId,input.traceTestId);
   return commands.getTraceTest(input.projectId,input.traceTestId)!;
  });},
  recordTraceTestValidation(input:Args<'recordTraceTestValidation'>[0]) {return transaction(now=>{
   current(input.projectId,input.traceTestId,input.revision);
   const status=traceTestValidationStatus(input.badEvidence.result,input.goodEvidence.result),diagnostic=input.diagnostic??traceTestValidationDiagnostic(input.badEvidence.result,input.goodEvidence.result);
   return validation(one('INSERT INTO trace_test_validations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *',id('ttv'),input.traceTestId,input.projectId,input.revision,status,
    JSON.stringify({...input.badEvidence,expectedResult:'fail',attempts:input.badAttempts??0,usage:input.badUsage??null}),JSON.stringify({...input.goodEvidence,expectedResult:'pass',attempts:input.goodAttempts??0,usage:input.goodUsage??null}),input.recordedByUserId??null,new Date(now).toISOString(),input.method??'automated',diagnostic,input.evaluator?JSON.stringify(input.evaluator):null,input.overrideReason??null)!);
  });},
  enableTraceTest(input:Args<'enableTraceTest'>[0]) {return transaction(now=>{
   current(input.projectId,input.traceTestId,input.expectedRevision);
   const old=one('SELECT * FROM trace_test_revisions WHERE project_id=? AND trace_test_id=? AND revision=?',input.projectId,input.traceTestId,input.expectedRevision)!;
   if(old.lifecycle!=='draft')throw new TraceTestValidationNotReadyError('Create a new draft revision before enabling this test again');
   const proof=one(`SELECT 1 FROM trace_test_validations WHERE project_id=? AND trace_test_id=? AND revision=? AND id=? AND status='passed' AND ((method='automated' AND evaluator IS NOT NULL) OR(method='manual_override' AND length(trim(override_reason))>=10))`,input.projectId,input.traceTestId,input.expectedRevision,input.validationId);
   if(!proof)throw new TraceTestValidationNotReadyError('A successful validation for the current draft is required before enabling this test');
   const number=input.expectedRevision+1,stamp=new Date(now).toISOString();
   const enabled={...old,id:id('ttr'),revision:number,lifecycle:'enabled',validation_id:input.validationId,validated_revision:input.expectedRevision,reviewed_by_user_id:input.reviewedByUserId,created_at:stamp,reviewed_at:stamp};
   run(`INSERT INTO trace_test_revisions(${Object.keys(enabled).join(',')}) VALUES(${Object.keys(enabled).map(()=>'?').join(',')})`,...Object.values(enabled));
   run('UPDATE trace_tests SET current_revision=?,enabled_revision=?,updated_at=? WHERE project_id=? AND id=?',number,number,stamp,input.projectId,input.traceTestId);
   return commands.getTraceTest(input.projectId,input.traceTestId)!;
  });},
  recordTraceTestFunnelEvent(input:Args<'recordTraceTestFunnelEvent'>[0]) {run(`INSERT INTO audit_logs VALUES(?,?,?,?,'trace_test_funnel',?,?,?) ON CONFLICT(project_id,target_id,action) WHERE target_type='trace_test_funnel' DO NOTHING`,id('audit'),input.projectId,input.actorUserId??null,`trace_test.funnel.${input.event}`,input.journeyId,JSON.stringify({event:input.event,elapsedMs:input.elapsedMs,intent:input.intent}),new Date().toISOString());}
 };
 return commands;
}
