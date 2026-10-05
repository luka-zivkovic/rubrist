import type { DatabaseSync } from 'node:sqlite';
import { registerSqliteValidator, type SqliteValidatorReader } from './command-context.js';
import { analysisJsonTextDigest } from './governed-json-text.js';
import { analysisPopulationFrameDigest, analysisPopulationFrameMemberDigest, analysisPopulationReferenceProvenance, compareCodeUnits } from '../../lib/analysis-population.js';

/** Independent streaming equivalent of PG analysis_recomputed_population_frame_digest_v1. */
function recomputedFrame(reader:SqliteValidatorReader,populationId:string):string|null {
 const population=reader.get('SELECT * FROM analysis_populations WHERE id=?',populationId);if(!population)return null;
 const frozen=reader.iterate('SELECT case_id,raw_trace_id,source_trace_id,input_digest,ingestion_time FROM analysis_population_members WHERE population_id=? ORDER BY ingestion_time,governed_utf16_sort_key_v1(case_id)',populationId);
 const current=reader.iterate(`SELECT c.id,c.created_at,c.normalized_payload,c.raw_trace_id,r.id retained_raw_trace_id,r.source_trace_id,
 (SELECT count(*) FROM case_input_identity_records i WHERE i.project_id=c.project_id AND i.source_case_id=c.id AND i.identity_basis='input-identity/v1' AND i.record_kind IN ('authoring_import','identity_resolved') AND i.input_digest IS NOT NULL) identity_count,
 (SELECT input_digest FROM case_input_identity_records i WHERE i.project_id=c.project_id AND i.source_case_id=c.id AND i.identity_basis='input-identity/v1' AND i.record_kind IN ('authoring_import','identity_resolved') AND i.input_digest IS NOT NULL ORDER BY CASE WHEN i.record_kind='authoring_import' THEN 0 ELSE 1 END,i.created_at,governed_utf16_sort_key_v1(i.id) LIMIT 1) input_digest
 FROM cases c LEFT JOIN raw_traces r ON r.project_id=c.project_id AND r.id=c.raw_trace_id
 WHERE c.project_id=? AND c.created_at>=? AND c.created_at<? AND c.ingestion_purpose='analysis_eligible_'||c.case_type AND c.case_type IN ('manual','langsmith','langfuse','ironside') ORDER BY c.created_at,governed_utf16_sort_key_v1(c.id)`,population.project_id!,population.window_start!,population.window_end!);
 let expected=frozen.next(),position=0;const digests:string[]=[];
 try {
  for(const row of current){
   if(row.retained_raw_trace_id===null||row.source_trace_id===null||row.input_digest===null||row.identity_count!==1)return null;
   if(reader.get('SELECT usage_class FROM governed_input_identity_claims WHERE project_id=? AND input_digest=?',population.project_id!,row.input_digest!)?.usage_class!=='nonsealed')return null;
   if(!expected.done){
    const order=compareCodeUnits(String(row.created_at),String(expected.value.ingestion_time))||compareCodeUnits(String(row.id),String(expected.value.case_id));
    if(order>0)return null;
    if(order===0){if(row.retained_raw_trace_id!==expected.value.raw_trace_id||row.source_trace_id!==expected.value.source_trace_id||row.input_digest!==expected.value.input_digest)return null;expected=frozen.next();}
   }
   // PG recomputation hashes the entire normalized payload, not the projected
   // revision item. Preserve that existing digest basis and exact SQL numbers.
   const itemDigest=analysisJsonTextDigest(`{"basis":"dataset-revision-item/v1","expectedFailStep":null,"inputIdentity":{"basis":"input-identity/v1","digest":${JSON.stringify(row.input_digest)}},"note":null,"redactedPayload":${String(row.normalized_payload)},"referenceLabel":null,"reviewProvenance":${JSON.stringify(analysisPopulationReferenceProvenance(String(row.id)))}}`);
   digests.push(analysisPopulationFrameMemberDigest({caseId:String(row.id),inputDigest:String(row.input_digest),itemDigest,ingestionTime:String(row.created_at),position}));position++;
  }
  if(!expected.done)return null;
  if(digests.length===0)return analysisJsonTextDigest(JSON.stringify({basis:'analysis-population-frame/v1',canonicalizationVersion:population.canonicalization_version,eligibleIngestionPurposes:JSON.parse(String(population.eligible_ingestion_purposes)),eligibleSources:JSON.parse(String(population.eligible_sources)),frameMemberDigests:[],orderingVersion:population.ordering_version,projectId:population.project_id,windowEnd:population.window_end,windowStart:population.window_start}));
  return analysisPopulationFrameDigest({projectId:String(population.project_id),windowStart:String(population.window_start),windowEnd:String(population.window_end),frameMemberDigests:digests});
 } finally {current.return?.();frozen.return?.();}
}
const initialized=new WeakSet<DatabaseSync>();
export function initializePopulationFrameValidator(db:DatabaseSync):void {
 if(initialized.has(db))return;
 registerSqliteValidator(db,'analysis_population_frame_valid_v1',['analysis_study_closure_insert'],(reader,populationId,expected)=>{
  if(typeof populationId!=='string'||(expected!==null&&typeof expected!=='string'))return false;
  return recomputedFrame(reader,populationId)===expected;
 });
 initialized.add(db);
}
