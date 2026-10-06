import type { DatabaseSync,SQLInputValue,SQLOutputValue } from 'node:sqlite';
import type { AnalysisCriterionPromotionCreateInput } from '@rubrist/shared';
import { AnalysisPromotionRepositoryError } from '../../analysis-promotion/repository.js';
import { nullableString,rowToSummary,rowToSupport,rowToPromotion } from '../../analysis-promotion/storage-values.js';
import * as promotion from '../../lib/analysis-promotion.js';
import { criterionVersionDigest } from '../../lib/criterion-digest.js';
import { canonicalGovernedJsonV1 } from '../../lib/governed-content-digest.js';
import { registerSqliteValidator,type SqliteValidatorReader } from './command-context.js';
export const repoError=(code:ConstructorParameters<typeof AnalysisPromotionRepositoryError>[0],message:string)=>new AnalysisPromotionRepositoryError(code,message);
export type Reader=Pick<SqliteValidatorReader,'get'|'iterate'>;
export const reader=(db:DatabaseSync):Reader=>({get:(sql,...values)=>db.prepare(sql).get(...values),iterate:(sql,...values)=>db.prepare(sql).iterate(...values)});
interface PromotionContext {
  studyId: string;
  state: string;
  populationId: string;
  drawId: string;
  sourceDatasetRevisionId: string;
  sourceDatasetRevisionContentDigest: string;
  sourceDatasetRevisionDigest: string;
  closureId: string;
  closureDigest: string;
  taxonomyId: string;
  taxonomyRevisionId: string;
  taxonomyRevisionSequence: number;
  taxonomyRevisionDigest: string;
  codeId: string;
  codeEntryId: string;
  codeEntryDigest: string;
  codeLabel: string;
  codeDefinition: string;
  codeStatus: string;
  isTaxonomyHead: boolean;
}

export function loadPromotionContext(
  read:Reader,
  projectId: string,
  input: AnalysisCriterionPromotionCreateInput
): PromotionContext {
  const row = read.get(
    `select study.id as study_id,coalesce((SELECT to_state FROM analysis_study_events WHERE study_id=study.id ORDER BY version DESC LIMIT 1),'draft') as state,
            study.population_id,study.draw_id,study.dataset_revision_id as source_dataset_revision_id,
            source_revision.content_digest as source_dataset_revision_content_digest,
            source_revision.revision_digest as source_dataset_revision_digest,
            closure.id as closure_id,closure.closure_digest,
            taxonomy.id as taxonomy_id,taxonomy_revision.id as taxonomy_revision_id,
            taxonomy_revision.sequence as taxonomy_revision_sequence,
            taxonomy_revision.revision_digest as taxonomy_revision_digest,
            code.code_id,code.id as code_entry_id,code.entry_digest as code_entry_digest,
            code.label as code_label,code.definition as code_definition,code.status as code_status,
            not exists(select 1 from analysis_failure_taxonomy_revisions successor
                       where successor.predecessor_revision_id=taxonomy_revision.id) as is_taxonomy_head
     from analysis_studies study
     left join analysis_study_closures closure
       on closure.id=? and closure.study_id=study.id and closure.project_id=study.project_id
     join dataset_revisions source_revision
       on source_revision.id=study.dataset_revision_id and source_revision.project_id=study.project_id
     join analysis_failure_taxonomies taxonomy
       on taxonomy.id=? and taxonomy.project_id=study.project_id
     left join analysis_failure_taxonomy_revisions taxonomy_revision
       on taxonomy_revision.id=? and taxonomy_revision.taxonomy_id=taxonomy.id
     left join analysis_failure_taxonomy_revision_codes code
       on code.taxonomy_revision_id=taxonomy_revision.id and code.code_id=?
     where study.project_id=? and study.id=?`,
input.expectedClosureId,input.taxonomyId,input.taxonomyRevisionId,input.codeId,projectId,input.studyId
  );  if (!row) throw repoError("analysis_promotion_not_found", "Analysis study or taxonomy was not found");
  return {
    studyId: String(row.study_id), state: String(row.state), populationId: String(row.population_id),
    drawId: String(row.draw_id), sourceDatasetRevisionId: String(row.source_dataset_revision_id),
    sourceDatasetRevisionContentDigest: String(row.source_dataset_revision_content_digest),
    sourceDatasetRevisionDigest: String(row.source_dataset_revision_digest),
    closureId: nullableString(row.closure_id) ?? "", closureDigest: nullableString(row.closure_digest) ?? "",
    taxonomyId: String(row.taxonomy_id), taxonomyRevisionId: nullableString(row.taxonomy_revision_id) ?? "",
    taxonomyRevisionSequence: Number(row.taxonomy_revision_sequence),
    taxonomyRevisionDigest: nullableString(row.taxonomy_revision_digest) ?? "",
    codeId: nullableString(row.code_id) ?? "", codeEntryId: nullableString(row.code_entry_id) ?? "",
    codeEntryDigest: nullableString(row.code_entry_digest) ?? "", codeLabel: nullableString(row.code_label) ?? "",
    codeDefinition: nullableString(row.code_definition) ?? "", codeStatus: nullableString(row.code_status) ?? "",
    isTaxonomyHead: Boolean(row.is_taxonomy_head)
  };
}

export function assertPromotionContext(context: PromotionContext, input: AnalysisCriterionPromotionCreateInput): void {
  if (context.state !== "coding_closed" && context.state !== "completed") {
    throw repoError("analysis_promotion_state_conflict", "Promotion requires a closed or completed analysis study");
  }
  if (context.closureId !== input.expectedClosureId || context.closureDigest !== input.expectedClosureDigest) {
    throw repoError("analysis_promotion_closure_conflict", "Promotion closure evidence changed");
  }
  if (!context.isTaxonomyHead || context.taxonomyRevisionId !== input.taxonomyRevisionId ||
    context.taxonomyRevisionDigest !== input.expectedTaxonomyRevisionDigest) {
    throw repoError("analysis_promotion_taxonomy_conflict", "Promotion requires the exact current taxonomy head");
  }
  if (context.codeId !== input.codeId || context.codeEntryDigest !== input.expectedCodeEntryDigest ||
    context.codeStatus !== "active") {
    throw repoError("analysis_promotion_code_conflict", "Promotion requires one active exact taxonomy code entry");
  }
}

export function candidateEvidence(read:Reader,projectId:string,studyId:string,revisionId:string,codeId:string){return [...read.iterate(`         select study.project_id,study.id as study_id,
                coalesce((SELECT to_state FROM analysis_study_events WHERE study_id=study.id ORDER BY version DESC LIMIT 1),'draft') as study_state,
                closure.id as closure_id,closure.closure_digest,
                taxonomy.id as taxonomy_id,revision.id as taxonomy_revision_id,
                revision.sequence as taxonomy_revision_sequence,revision.revision_digest as taxonomy_revision_digest,
                entry.code_id,entry.id as code_entry_id,entry.entry_digest as code_entry_digest,
                entry.label as code_label,entry.definition as code_definition,entry.status as code_status,
                item.id as study_item_id,closure_item.id as closure_item_id,
                closure_item.content_digest as closure_item_digest,closure_item.position,
                study.dataset_revision_id as source_dataset_revision_id,
                source_item.id as source_dataset_revision_item_id,source_item.item_digest as source_item_digest,
                observation.id as observation_event_id,observation.event_digest as observation_event_digest,
                observation.failure_label,observation.rationale as observation_rationale,
                observation.anchor_kind,observation.anchor_step_index,
                assignment.id as assignment_event_id,assignment.event_digest as assignment_event_digest,
                assignment.rationale as assignment_rationale,observation.actor_subject_id as observation_author_subject_id,observation.actor_user_id as observation_author_user_id
         from analysis_studies study
         join analysis_study_closures closure on closure.study_id=study.id and closure.project_id=study.project_id
         join analysis_study_closure_items closure_item
           on closure_item.closure_id=closure.id and closure_item.project_id=study.project_id
         join analysis_study_items item on item.id=closure_item.study_item_id and item.project_id=study.project_id
         join dataset_revision_items source_item
           on source_item.id=item.revision_item_id and source_item.revision_id=study.dataset_revision_id
         join json_each(closure_item.active_failure_observation_event_ids) slot
         join analysis_study_item_events observation
           on observation.id=slot.value
          and observation.event_type='failure_observed' and observation.project_id=study.project_id and observation.study_item_id=item.id and observation.event_digest=json_extract(closure_item.active_failure_observation_event_digests,'$['||slot.key||']')
         join analysis_observation_assignment_events assignment
           on assignment.id=json_extract(closure_item.active_failure_assignment_event_ids,'$['||slot.key||']')
          and assignment.project_id=study.project_id and assignment.study_item_id=item.id and assignment.observation_event_id=observation.id and assignment.event_digest=json_extract(closure_item.active_failure_assignment_event_digests,'$['||slot.key||']')
         join analysis_failure_taxonomies taxonomy on taxonomy.project_id=study.project_id
         join analysis_failure_taxonomy_revisions revision
           on revision.id=? and revision.taxonomy_id=taxonomy.id and revision.project_id=study.project_id
         join analysis_failure_taxonomy_revision_codes entry
           on entry.taxonomy_revision_id=revision.id and entry.code_id=? and entry.project_id=study.project_id
         join analysis_observation_assignment_events head
           on head.id=(SELECT a.id FROM analysis_observation_assignment_events a WHERE a.observation_event_id=observation.id AND a.taxonomy_revision_sequence<=revision.sequence ORDER BY a.version DESC LIMIT 1)
          and head.id=assignment.id and head.event_digest=assignment.event_digest and head.event_type='assigned'
          and head.taxonomy_id=taxonomy.id and head.code_id=entry.code_id
         where study.project_id=? and study.id=?
           and coalesce((SELECT to_state FROM analysis_study_events WHERE study_id=study.id ORDER BY version DESC LIMIT 1),'draft') in ('coding_closed','completed')
           and entry.status='active'
           and not exists (select 1 from analysis_failure_taxonomy_revisions successor
                           where successor.predecessor_revision_id=revision.id)
`, revisionId,codeId,projectId,studyId)];}
export function promotionSummarySelect(): string {
  return `select promotion.*,promotion.id as promotion_id,
                 substr(promotion.created_at,1,23)||'000Z' as cursor_created_at,
                 criterion.stable_key as criterion_stable_key_row,
                 criterion.source_kind as criterion_source_kind,
                 criterion.created_by_user_id as criterion_created_by_user_id,
                 criterion.created_at as criterion_created_at,
                 version.revision as criterion_version_revision,version.name as criterion_version_name,
                 version.definition as criterion_version_definition,
                 version.criterion_digest as criterion_version_digest,
                 version.source_kind as criterion_version_source_kind,
                 version.created_by_user_id as criterion_version_created_by_user_id,
                 version.created_at as criterion_version_created_at
          from analysis_criterion_promotions promotion
          join criteria criterion on criterion.id=promotion.criterion_id and criterion.project_id=promotion.project_id
          join criterion_versions version on version.id=promotion.criterion_version_id and version.project_id=promotion.project_id`;
}

export function authoringExposureDetails(p:Record<string,unknown>){return {codeId:p.code_id,contract:'rubrist/analysis-criterion-promotion-exposure/v1',criterionId:p.criterion_id,criterionVersionId:p.criterion_version_id,promotionId:p.id,studyClosureId:p.study_closure_id,studyId:p.study_id,taxonomyId:p.taxonomy_id,taxonomyRevisionId:p.taxonomy_revision_id};}
export function supportExposureDetails(p:Record<string,unknown>,s:Record<string,unknown>){return {assignmentEventId:s.assignment_event_id,closureItemId:s.closure_item_id,contract:'rubrist/analysis-criterion-promotion-support-exposure/v1',criterionId:p.criterion_id,criterionVersionId:p.criterion_version_id,observationEventId:s.observation_event_id,promotionId:p.id,promotionSupportId:s.id,studyId:s.study_id,studyItemId:s.study_item_id};}
const initialized=new WeakSet<DatabaseSync>();
export function initializePromotionValidator(db:DatabaseSync){
 if(initialized.has(db))return;
 registerSqliteValidator(db,'analysis_promotion_bundle_valid_v1',['analysis_promotion_finalize'],(read,projectId,promotionId)=>{
  const p=read.get('SELECT * FROM analysis_criterion_promotions WHERE project_id=? AND id=?',projectId,promotionId);if(!p)return false;
  const rawSupports=[...read.iterate('SELECT * FROM analysis_criterion_promotion_supports WHERE promotion_id=? ORDER BY position',promotionId)];
  const supports=rawSupports.map(rowToSupport),artifact=rowToPromotion(p);
  const input:AnalysisCriterionPromotionCreateInput={studyId:artifact.studyId,expectedClosureId:artifact.studyClosureId,expectedClosureDigest:artifact.studyClosureDigest,taxonomyId:artifact.taxonomyId,taxonomyRevisionId:artifact.taxonomyRevisionId,expectedTaxonomyRevisionDigest:artifact.taxonomyRevisionDigest,codeId:artifact.codeId,expectedCodeEntryDigest:artifact.codeEntryDigest,criterionName:artifact.criterionName,criterionDefinition:artifact.criterionDefinition,rationale:artifact.rationale,idempotencyKey:artifact.idempotencyKey,supportingObservations:supports.map(s=>({studyItemId:s.studyItemId,closureItemId:s.closureItemId,closureItemDigest:s.closureItemDigest,observationEventId:s.observationEventId,observationEventDigest:s.observationEventDigest,assignmentEventId:s.assignmentEventId,assignmentEventDigest:s.assignmentEventDigest}))};
  const context=loadPromotionContext(read,String(projectId),input);assertPromotionContext(context,input);
  if(!read.get("SELECT 1 FROM project_members m JOIN governed_reviewer_subjects s ON s.project_id=m.project_id AND s.account_user_id=m.user_id WHERE m.project_id=? AND m.user_id=? AND m.role='owner' AND s.id=?",projectId,p.promoted_by_user_id!,p.promoted_by_subject_id!))return false;
  if(context.populationId!==artifact.populationId||context.drawId!==artifact.drawId||context.sourceDatasetRevisionId!==artifact.sourceDatasetRevisionId||context.sourceDatasetRevisionContentDigest!==artifact.sourceDatasetRevisionContentDigest||context.sourceDatasetRevisionDigest!==artifact.sourceDatasetRevisionDigest||context.taxonomyRevisionSequence!==artifact.taxonomyRevisionSequence||context.codeEntryId!==artifact.codeEntryId||context.codeLabel!==artifact.codeLabel||context.codeDefinition!==artifact.codeDefinition)return false;
  if(!read.get("SELECT 1 FROM analysis_study_closures c JOIN dataset_revisions r ON r.project_id=c.project_id AND r.id=c.dataset_revision_id WHERE c.id=? AND c.project_id=? AND c.population_id=? AND c.draw_id=? AND c.dataset_revision_id=? AND r.role='analysis_authoring' AND r.source_kind='analysis_population'",p.study_closure_id!,projectId,p.population_id!,p.draw_id!,p.source_dataset_revision_id!))return false;
  if(artifact.criterionStableKey!==promotion.analysisCriterionPromotionStableKey(artifact.codeId)||artifact.criterionDigest!==criterionVersionDigest({criterionId:artifact.criterionId,criterionVersionId:artifact.criterionVersionId,criterionName:artifact.criterionName,criterionDefinition:artifact.criterionDefinition}))return false;
  const evidence=candidateEvidence(read,String(projectId),artifact.studyId,artifact.taxonomyRevisionId,artifact.codeId),byObservation=new Map(evidence.map(e=>[String(e.observation_event_id),e]));
  const canonical=promotion.canonicalizeAnalysisCriterionPromotionSupports(input.supportingObservations);
  if(supports.length!==artifact.supportCount)return false;
  for(const [position,s] of supports.entries()){
   const e=byObservation.get(s.observationEventId),raw=rawSupports[position]!;if(!e||canonical[position]?.observationEventId!==s.observationEventId||s.position!==position||s.projectId!==artifact.projectId||s.studyId!==artifact.studyId||s.closureId!==artifact.studyClosureId||s.sourceDatasetRevisionId!==artifact.sourceDatasetRevisionId||raw.created_at!==p.created_at)return false;
   for(const key of ['study_item_id','closure_item_id','closure_item_digest','source_dataset_revision_item_id','source_item_digest','observation_event_id','observation_event_digest','assignment_event_id','assignment_event_digest','observation_author_subject_id','observation_author_user_id'])if(raw[key]!==e[key])return false;
   if(s.contentDigest!==promotion.analysisCriterionPromotionSupportContentDigest(s))return false;
  }
  if(artifact.requestDigest!==promotion.analysisCriterionPromotionRequestDigest(artifact.projectId,input)||artifact.supportSetDigest!==promotion.analysisCriterionPromotionSupportSetDigest(artifact.id,supports))return false;
  const summary=read.get(promotionSummarySelect()+' WHERE promotion.id=?',promotionId);if(!summary)return false;
  const handoff=rowToSummary(summary).handoff;
  if(artifact.handoffDigest!==promotion.analysisCriterionPromotionHandoffDigest(handoff)||artifact.contentDigest!==promotion.analysisCriterionPromotionContentDigest(artifact))return false;
  if(!read.get("SELECT 1 FROM criteria c JOIN criterion_versions v ON v.criterion_id=c.id AND v.project_id=c.project_id WHERE c.id=? AND c.project_id=? AND c.stable_key=? AND c.source_kind='analysis_promotion' AND c.created_by_user_id=? AND c.created_at=? AND v.id=? AND v.revision=1 AND v.name=? AND v.definition=? AND v.criterion_digest=? AND v.source_kind='analysis_promotion' AND v.created_by_user_id=c.created_by_user_id AND v.created_at=c.created_at",p.criterion_id!,projectId,p.criterion_stable_key!,p.promoted_by_user_id!,p.created_at!,p.criterion_version_id!,p.criterion_name!,p.criterion_definition!,p.criterion_digest!))return false;
  if(Number(read.get('SELECT count(*) n FROM criterion_versions WHERE criterion_id=?',p.criterion_id!)!.n)!==1||read.get('SELECT 1 FROM skills WHERE criterion_id=?',p.criterion_id!)||read.get('SELECT 1 FROM skill_versions WHERE criterion_id=?',p.criterion_id!))return false;
  const exposures=[...read.iterate("SELECT * FROM dataset_exposure_events WHERE project_id=? AND evidence_ref_kind='analysis_criterion_promotion' AND evidence_ref_id=?",projectId,promotionId)];
  if(exposures.length!==supports.length+1)return false;
  for(const exposure of exposures){
   const authoring=exposure.id===p.criterion_authoring_exposure_event_id,s=rawSupports.find(s=>s.example_selection_exposure_event_id===exposure.id);if(!authoring&&!s)return false;
   if(exposure.project_id!==p.project_id||exposure.revision_id!==p.source_dataset_revision_id||exposure.revision_item_id!==(authoring?null:s!.source_dataset_revision_item_id)||exposure.kind!=='development_use'||exposure.exposure_class!=='development'||exposure.activity!==(authoring?'criterion_authoring':'example_selection')||exposure.subject_kind!=='person'||exposure.subject_id!==(authoring?p.promoted_by_subject_id:s!.observation_author_subject_id)||exposure.actor_user_id!==p.promoted_by_user_id||exposure.reason!==(authoring?'Analysis failure-code criterion authoring':'Analysis promotion supporting observation')||exposure.occurred_at!==p.created_at||exposure.idempotency_key!==(authoring?`analysis-promotion:criterion-authoring:${p.id}`:`analysis-promotion:example-selection:${p.id}:${s!.id}`))return false;
   if(canonicalGovernedJsonV1(JSON.parse(String(exposure.details)))!==canonicalGovernedJsonV1(authoring?authoringExposureDetails(p):supportExposureDetails(p,s!)))return false;
  }
  return true;
 });initialized.add(db);
}
