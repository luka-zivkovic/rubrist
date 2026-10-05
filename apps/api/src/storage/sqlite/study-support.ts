import type { DatabaseSync } from 'node:sqlite';
import { ANALYSIS_POPULATION_API_PAGE_MAX } from '@rubrist/shared';
import { AnalysisStudyRepositoryError,type AnalysisStudyAccess } from '../../analysis-study/repository.js';
import { sqliteCommand,type SqliteCommandContext } from './command-context.js';
import { closeStudyIfDue } from './study-closure.js';
import { clearStudyDeadlineFailure,recordStudyDeadlineFailure } from './study-deadlines.js';
import { populationSubject } from './population-build.js';

export const studyError=(code:ConstructorParameters<typeof AnalysisStudyRepositoryError>[0],message:string,details:Readonly<Record<string,string|number|boolean|null>>={})=>new AnalysisStudyRepositoryError(code,message,details);
export function studyAccess(db:DatabaseSync,access:AnalysisStudyAccess,owner=false):'owner'|'member' {
 const role=db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(access.projectId,access.userId)?.role;
 if((role!=='owner'&&role!=='member')||(owner&&(role!=='owner'||access.projectRole!=='owner')))throw studyError('analysis_study_forbidden','Analysis study access is forbidden');
 return role;
}
export function studySubject(db:DatabaseSync,c:SqliteCommandContext,access:AnalysisStudyAccess){return populationSubject(db,access,c.timestamp);}

export function studyWrite<T>(db:DatabaseSync,work:(c:SqliteCommandContext)=>T,clock=Date.now):T {
 try{return sqliteCommand(db,work,clock);}catch(error){
  if(error instanceof AnalysisStudyRepositoryError)throw error;
  if((error as {code?:unknown})?.code==='ERR_SQLITE_ERROR'){
   const message=error instanceof Error?error.message:'';
   if(/deadline/i.test(message))throw studyError('analysis_study_deadline_invalid','The frozen study deadline does not permit this command');
   if(/predecessor|version|CAS/i.test(message))throw studyError('analysis_study_version_conflict','Study compare-and-swap version does not match');
   if(/anchor/i.test(message))throw studyError('analysis_study_anchor_invalid','Evidence anchor does not exist in the frozen item');
   if(/taxonomy|code/i.test(message)&&!/coding/.test(message))throw studyError('analysis_taxonomy_conflict','Failure taxonomy command conflicts with retained history');
   throw studyError('analysis_study_state_conflict','Study command conflicts with retained history');
  }
  throw error;
 }
}
/** Deadline effects commit separately so a subsequent stale mutation cannot undo them. */
export function ensureStudyDueClosure(db:DatabaseSync,projectId:string,studyId:string,clock=Date.now):void {
 try{studyWrite(db,c=>{closeStudyIfDue(db,c,projectId,studyId);clearStudyDeadlineFailure(c,projectId,studyId);},clock);}
 catch(error){try{recordStudyDeadlineFailure(db,projectId,studyId,clock);}catch{/* Keep the original failure. */}throw error;}
}

export interface StudyCursor {kind:'chronological'|'position'|'version'|'sequence';primary:string;id?:string}
export const encodeStudyCursor=(value:StudyCursor)=>Buffer.from(JSON.stringify({v:1,...value}),'utf8').toString('base64url');
export function decodeStudyCursor(value:string|null,kind:StudyCursor['kind']):StudyCursor|null {
 if(value===null)return null;
 try{
  const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as Record<string,unknown>;
  if(parsed.v!==1||parsed.kind!==kind||typeof parsed.primary!=='string'||parsed.primary.length<1||parsed.primary.length>240)throw new Error('shape');
  if(kind==='chronological'){
   if(typeof parsed.id!=='string'||!parsed.id.length||parsed.id.length>240||parsed.id.includes('\0')||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed.primary)||new Date(parsed.primary).toISOString()!==parsed.primary)throw new Error('timestamp');
   return {kind,primary:parsed.primary,id:parsed.id};
  }
  if(!/^(0|[1-9][0-9]*)$/.test(parsed.primary)||BigInt(parsed.primary)>(kind==='version'?9223372036854775807n:kind==='position'?9999n:10000n))throw new Error('numeric');
  return {kind,primary:parsed.primary};
 }catch{throw studyError('analysis_study_invalid_cursor','Invalid study page cursor');}
}
export function studyPageLimit(value:number){if(!Number.isSafeInteger(value)||value<1||value>ANALYSIS_POPULATION_API_PAGE_MAX)throw studyError('analysis_study_invalid_cursor','Invalid study page limit');return value;}
