import type { SQLInputValue } from 'node:sqlite';
import type { SqliteCommandContext } from './command-context.js';

type StudyTable='analysis_studies'|'analysis_study_items'|'analysis_study_finalizations'|'analysis_study_events'|'analysis_study_item_events'|'analysis_study_item_views'|'analysis_study_closures'|'analysis_study_closure_items'|'analysis_study_closure_finalizations'|'analysis_failure_taxonomies'|'analysis_failure_taxonomy_revisions'|'analysis_failure_codes'|'analysis_failure_taxonomy_revision_codes'|'analysis_taxonomy_finalizations'|'analysis_observation_assignment_events';
/** Internal explicit domain records only; table and column names never come from requests. */
export function insertStudyRecord(c:SqliteCommandContext,table:StudyTable,value:Record<string,SQLInputValue|boolean|readonly (string|null)[]>):void {
 const entries=Object.entries(value).map(([key,value])=>[key.replace(/[A-Z]/g,letter=>'_'+letter.toLowerCase()),typeof value==='boolean'?Number(value):Array.isArray(value)?JSON.stringify(value):value] as [string,SQLInputValue]);
 c.db.prepare(`INSERT INTO ${table}(${entries.map(([key])=>key).join(',')}) VALUES(${entries.map(()=>'?').join(',')})`).run(...entries.map(([,value])=>value));
}
