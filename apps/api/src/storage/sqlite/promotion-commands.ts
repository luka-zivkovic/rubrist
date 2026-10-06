import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,type AnalysisCriterionPromotionSupportArtifact,type AnalysisCriterionPromotionHandoff,type AnalysisCriterionPromotionCreateResult} from '@rubrist/shared';
import type {AnalysisPromotionRepository} from '../../analysis-promotion/repository.js';
import {AnalysisPromotionRepositoryError} from '../../analysis-promotion/repository.js';
import {rowToSummary,rowToSupport,rowToCandidate,encodeCursor,decodePositionCursor,decodeTimestampCursor} from '../../analysis-promotion/storage-values.js';
import {stableId} from '../../governed-review/storage-values.js';
import {criterionVersionDigest} from '../../lib/criterion-digest.js';
import {governedReviewSubject} from './governed-subject-commands.js';
import {sqliteCommand} from './command-context.js';
import {reader,repoError,initializePromotionValidator,loadPromotionContext,assertPromotionContext,candidateEvidence,promotionSummarySelect,authoringExposureDetails,supportExposureDetails} from './promotion-values.js';
import {
  analysisCriterionPromotionContentDigest,
  analysisCriterionPromotionHandoffDigest,
  analysisCriterionPromotionRequestDigest,
  analysisCriterionPromotionStableKey,
  analysisCriterionPromotionSupportContentDigest,
  analysisCriterionPromotionSupportSetDigest,
  canonicalizeAnalysisCriterionPromotionSupports,
  decideAnalysisCriterionPromotionCommand
} from "../../lib/analysis-promotion.js";

const snake=(value:Record<string,unknown>):Record<string,SQLInputValue>=>Object.fromEntries(Object.entries(value).map(([k,v])=>[k.replace(/[A-Z]/g,m=>'_'+m.toLowerCase()),v])) as Record<string,SQLInputValue>;
export function sqlitePromotionCommands(db:DatabaseSync,clock=Date.now){
 initializePromotionValidator(db);
 const read=reader(db);
 const summary=(projectId:string,id:string)=>{const row=db.prepare(promotionSummarySelect()+' WHERE promotion.project_id=? AND promotion.id=?').get(projectId,id);return row?rowToSummary(row):null;};
 const result=(projectId:string,id:string,replayed:boolean):AnalysisCriterionPromotionCreateResult=>({...summary(projectId,id)!,supports:db.prepare('SELECT * FROM analysis_criterion_promotion_supports WHERE project_id=? AND promotion_id=? ORDER BY position').all(projectId,id).map(rowToSupport),replayed});
 return {
 promotionCreate(...[actor,input]:Parameters<AnalysisPromotionRepository['createPromotion']>){
  if(actor.projectRole!=='owner')throw repoError('analysis_promotion_forbidden','Only project owners may promote analysis codes');
  const requestDigest=analysisCriterionPromotionRequestDigest(actor.projectId,input);
  try{return sqliteCommand(db,c=>{
   if(db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(actor.projectId,actor.userId)?.role!=='owner')throw repoError('analysis_promotion_forbidden','The promotion actor is not a current project owner');
   const subjectId=governedReviewSubject(db,actor.projectId,actor.userId,c.timestamp);
   const prior=db.prepare('SELECT id,idempotency_key,request_digest,code_id FROM analysis_criterion_promotions WHERE project_id=? AND (idempotency_key=? OR code_id=?)').all(actor.projectId,input.idempotencyKey,input.codeId);
   const existing=(row:typeof prior[number]|undefined)=>row?{promotionId:String(row.id),idempotencyKey:String(row.idempotency_key),requestDigest:String(row.request_digest)}:null;
   const decision=decideAnalysisCriterionPromotionCommand({idempotencyKey:input.idempotencyKey,requestDigest,existingByIdempotencyKey:existing(prior.find(r=>r.idempotency_key===input.idempotencyKey)),existingForCode:existing(prior.find(r=>r.code_id===input.codeId))});
   if(decision.kind==='conflict')throw repoError(decision.code,'Promotion conflicts with an existing immutable command');
   if(decision.kind==='replay')return result(actor.projectId,decision.promotionId,true);
   const context=loadPromotionContext(read,actor.projectId,input);assertPromotionContext(context,input);
   const canonicalInputs=canonicalizeAnalysisCriterionPromotionSupports(input.supportingObservations);
   const evidenceRows=candidateEvidence(read,actor.projectId,input.studyId,input.taxonomyRevisionId,input.codeId).filter(e=>canonicalInputs.some(s=>s.observationEventId===e.observation_event_id));
      const evidenceByObservation = new Map(
        evidenceRows.map((row) => [String(row.observation_event_id), row])
      );
      if (evidenceByObservation.size !== canonicalInputs.length) {
        throw repoError(
          "analysis_promotion_support_conflict",
          "Every promotion support must be an active closed-study observation assigned to the named code"
        );
      }

      const promotionId = stableId("aprom", actor.projectId, input.codeId);
      const criterionId = stableId("criterion", promotionId);
      const criterionVersionId = stableId("criterionv", promotionId, "1");
      const criterionStableKey = analysisCriterionPromotionStableKey(input.codeId);
      const criterionDigest = criterionVersionDigest({
        criterionId,
        criterionVersionId,
        criterionName: input.criterionName,
        criterionDefinition: input.criterionDefinition
      });
      const criterionAuthoringExposureEventId = stableId("dse", promotionId, "criterion-authoring");

      const supports = canonicalInputs.map((requested, position) => {
        const evidence = evidenceByObservation.get(requested.observationEventId);
        if (!evidence || !requestedSupportMatchesEvidence(requested, evidence)) {
          throw repoError(
            "analysis_promotion_support_conflict",
            "Promotion support no longer matches the frozen closure and assignment evidence"
          );
        }
        const supportId = stableId("aproms", promotionId, requested.observationEventId);
        const exampleSelectionExposureEventId = stableId("dse", promotionId, supportId, "example-selection");
        const content = {
          promotionId,
          position,
          studyId: context.studyId,
          studyItemId: String(evidence.study_item_id),
          closureId: context.closureId,
          closureItemId: String(evidence.closure_item_id),
          closureItemDigest: String(evidence.closure_item_digest),
          sourceDatasetRevisionId: context.sourceDatasetRevisionId,
          sourceDatasetRevisionItemId: String(evidence.source_dataset_revision_item_id),
          sourceItemDigest: String(evidence.source_item_digest),
          observationEventId: String(evidence.observation_event_id),
          observationEventDigest: String(evidence.observation_event_digest),
          assignmentEventId: String(evidence.assignment_event_id),
          assignmentEventDigest: String(evidence.assignment_event_digest),
          observationAuthorSubjectId: String(evidence.observation_author_subject_id),
          exampleSelectionExposureEventId
        };
        return {
          id: supportId,
          observationAuthorUserId: String(evidence.observation_author_user_id),
          artifact: {
            id: supportId,
            projectId: actor.projectId,
            ...content,
            contentDigest: analysisCriterionPromotionSupportContentDigest(content),
            createdAt: "1970-01-01T00:00:00.000Z"
          } satisfies AnalysisCriterionPromotionSupportArtifact
        };
      });
      const supportSetDigest = analysisCriterionPromotionSupportSetDigest(
        promotionId,
        supports.map(({ artifact }) => artifact)
      );
      const handoffWithoutDigest: Omit<AnalysisCriterionPromotionHandoff, "handoffDigest"> = {
        handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
        promotionId,
        projectId: actor.projectId,
        criterionId,
        criterionVersionId,
        criterionDigest,
        sourceDatasetRevisionId: context.sourceDatasetRevisionId,
        sourceDatasetRevisionContentDigest: context.sourceDatasetRevisionContentDigest,
        sourceDatasetRevisionDigest: context.sourceDatasetRevisionDigest,
        roleIntent: "analysis_authoring",
        sourceKind: "analysis_promotion_handoff",
        evidenceClass: "development_authoring_not_truth",
        createsTruth: false,
        createsEvaluator: false
      };
      const handoffDigest = analysisCriterionPromotionHandoffDigest(handoffWithoutDigest);
      const promotionContent = {
        contractVersion: ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION,
        projectId: actor.projectId,
        studyId: context.studyId,
        studyClosureId: context.closureId,
        studyClosureDigest: context.closureDigest,
        populationId: context.populationId,
        drawId: context.drawId,
        sourceDatasetRevisionId: context.sourceDatasetRevisionId,
        sourceDatasetRevisionContentDigest: context.sourceDatasetRevisionContentDigest,
        sourceDatasetRevisionDigest: context.sourceDatasetRevisionDigest,
        taxonomyId: context.taxonomyId,
        taxonomyRevisionId: context.taxonomyRevisionId,
        taxonomyRevisionSequence: context.taxonomyRevisionSequence,
        taxonomyRevisionDigest: context.taxonomyRevisionDigest,
        codeId: context.codeId,
        codeEntryId: context.codeEntryId,
        codeEntryDigest: context.codeEntryDigest,
        codeLabel: context.codeLabel,
        codeDefinition: context.codeDefinition,
        criterionId,
        criterionVersionId,
        criterionStableKey,
        criterionName: input.criterionName,
        criterionDefinition: input.criterionDefinition,
        criterionDigest,
        rationale: input.rationale,
        supportCount: supports.length,
        supportSetDigest,
        criterionAuthoringExposureEventId,
        promotedBySubjectId: subjectId,
        handoffVersion: ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION,
        handoffDigest
      } as const;
      const contentDigest = analysisCriterionPromotionContentDigest(promotionContent);


   const insert=(table:string,row:Record<string,SQLInputValue>)=>c.db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
   const p={id:promotionId,...snake(promotionContent),promoted_by_user_id:actor.userId,promoter_role:'owner',idempotency_key:input.idempotencyKey,request_digest:requestDigest,content_digest:contentDigest,created_at:c.timestamp,created_command_token:c.token};
   insert('analysis_criterion_promotions',p);
   insert('criteria',{id:criterionId,project_id:actor.projectId,stable_key:criterionStableKey,source_kind:'analysis_promotion',created_by_user_id:actor.userId,created_at:c.timestamp});
   insert('criterion_versions',{id:criterionVersionId,project_id:actor.projectId,criterion_id:criterionId,revision:1,name:input.criterionName,definition:input.criterionDefinition,criterion_digest:criterionDigest,source_kind:'analysis_promotion',created_by_user_id:actor.userId,created_at:c.timestamp});
   const supportRows:Record<string,SQLInputValue>[]=supports.map(s=>({...snake(s.artifact),observation_author_user_id:s.observationAuthorUserId,created_at:c.timestamp}));
   for(const row of supportRows)insert('analysis_criterion_promotion_supports',row);
   const base={project_id:actor.projectId,revision_id:context.sourceDatasetRevisionId,kind:'development_use',exposure_class:'development',subject_kind:'person',actor_user_id:actor.userId,evidence_ref_kind:'analysis_criterion_promotion',evidence_ref_id:promotionId,occurred_at:c.timestamp};
   insert('dataset_exposure_events',{...base,id:criterionAuthoringExposureEventId,revision_item_id:null,activity:'criterion_authoring',subject_id:subjectId,reason:'Analysis failure-code criterion authoring',details:JSON.stringify(authoringExposureDetails(p)),idempotency_key:`analysis-promotion:criterion-authoring:${promotionId}`});
   for(const s of supportRows)insert('dataset_exposure_events',{...base,id:s.example_selection_exposure_event_id!,revision_item_id:s.source_dataset_revision_item_id!,activity:'example_selection',subject_id:s.observation_author_subject_id!,reason:'Analysis promotion supporting observation',details:JSON.stringify(supportExposureDetails(p,s)),idempotency_key:`analysis-promotion:example-selection:${promotionId}:${s.id}`});
   insert('analysis_promotion_finalizations',{project_id:actor.projectId,promotion_id:promotionId,command_token:c.token});
   return result(actor.projectId,promotionId,false);
  },clock);}catch(error){if(error instanceof AnalysisPromotionRepositoryError)throw error;const e=error as {errcode?:number;message?:string};if(((e.errcode??0)&255)===19)throw repoError('analysis_promotion_state_conflict','Promotion conflicts with immutable governed evidence');throw error;}
 },
 promotionGet(...[access,id]:Parameters<AnalysisPromotionRepository['getPromotion']>){return summary(access.projectId,id);},
 promotionList(...[access,studyId,page]:Parameters<AnalysisPromotionRepository['listPromotions']>){
  const cursor=decodeTimestampCursor(page.cursor),stamp=cursor?.createdAt??null;
  const rows=db.prepare(promotionSummarySelect()+' WHERE promotion.project_id=? AND promotion.study_id=? AND (? IS NULL OR (substr(promotion.created_at,1,23)||\'000Z\',promotion.id)<(?,?)) ORDER BY promotion.created_at DESC,promotion.id DESC LIMIT ?').all(access.projectId,studyId,stamp,stamp,cursor?.id??null,page.limit+1);
  const items=rows.slice(0,page.limit),last=items.at(-1);
  return {items:items.map(rowToSummary),totalCount:String(db.prepare('SELECT count(*) n FROM analysis_criterion_promotions WHERE project_id=? AND study_id=?').get(access.projectId,studyId)!.n),nextCursor:rows.length>page.limit&&last?encodeCursor({v:1,kind:'promotion',createdAt:last.cursor_created_at,id:last.promotion_id}):null};
 },
 promotionSupports(...[access,id,page]:Parameters<AnalysisPromotionRepository['listSupports']>){
  const p=db.prepare('SELECT support_count FROM analysis_criterion_promotions WHERE project_id=? AND id=?').get(access.projectId,id);if(!p)return null;
  const cursor=decodePositionCursor(page.cursor,'support'),rows=db.prepare('SELECT * FROM analysis_criterion_promotion_supports WHERE project_id=? AND promotion_id=? AND (? IS NULL OR (position,id)>(?,?)) ORDER BY position,id LIMIT ?').all(access.projectId,id,cursor?.position??null,cursor?.position??null,cursor?.id??null,page.limit+1),items=rows.slice(0,page.limit),last=items.at(-1);
  return {items:items.map(rowToSupport),totalCount:Number(p.support_count),nextCursor:rows.length>page.limit&&last?encodeCursor({v:1,kind:'support',position:last.position,id:last.id}):null};
 },
 promotionCandidates(...[access,input]:Parameters<AnalysisPromotionRepository['listCandidates']>){
  const cursor=decodePositionCursor(input.cursor,'candidate'),rows=candidateEvidence(read,access.projectId,input.studyId,input.taxonomyRevisionId,input.codeId).sort((a,b)=>Number(a.position)-Number(b.position)||Buffer.compare(Buffer.from(String(a.observation_event_id)),Buffer.from(String(b.observation_event_id))));
  const filtered=rows.filter(r=>!cursor||Number(r.position)>cursor.position||(Number(r.position)===cursor.position&&Buffer.compare(Buffer.from(String(r.observation_event_id)),Buffer.from(cursor.id))>0)),items=filtered.slice(0,input.limit),last=items.at(-1);
  return {items:items.map(rowToCandidate),totalCount:String(rows.length),nextCursor:filtered.length>input.limit&&last?encodeCursor({v:1,kind:'candidate',position:last.position,id:last.observation_event_id}):null};
 }
 };
}
function requestedSupportMatchesEvidence(
  requested: Parameters<AnalysisPromotionRepository['createPromotion']>[1]['supportingObservations'][number],
  evidence: Record<string,unknown>
): boolean {
  return requested.studyItemId === String(evidence.study_item_id) &&
    requested.closureItemId === String(evidence.closure_item_id) &&
    requested.closureItemDigest === String(evidence.closure_item_digest) &&
    requested.observationEventId === String(evidence.observation_event_id) &&
    requested.observationEventDigest === String(evidence.observation_event_digest) &&
    requested.assignmentEventId === String(evidence.assignment_event_id) &&
    requested.assignmentEventDigest === String(evidence.assignment_event_digest);
}
