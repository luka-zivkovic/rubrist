import {
 ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION, ANALYSIS_TAXONOMY_CONTRACT_VERSION,
 AnalysisStudyProjectionSchema, AnalysisStudyItemProjectionSchema, AnalysisStudyItemEventArtifactSchema,
 type AnalysisStudyProjection, type AnalysisStudySummary, type AnalysisStudyClosureArtifact,
 type AnalysisStudyStoppingRule, type AnalysisStudyItemProjection, type AnalysisStudyEventArtifact,
 type AnalysisStudyItemEventArtifact, type AnalysisFailureTaxonomyArtifact,
 type AnalysisTaxonomyRevisionArtifact, type AnalysisTaxonomyRevisionCodeArtifact,
 type AnalysisObservationAssignmentEventArtifact
} from '@rubrist/shared';

// Backend-neutral mapping from explicit storage projections to public artifacts.
export function rowToStudyProjection(row: Record<string, unknown>): AnalysisStudyProjection {
  const stoppingRule = row.stopping_rule === null || row.stopping_rule === undefined ? null : {
    kind: String(row.stopping_rule),
    closeAt: row.stopping_rule === "server_deadline" ? iso(row.close_at) : null
  };
  return AnalysisStudyProjectionSchema.parse({
    study: {
      id: String(row.study_id), projectId: String(row.project_id),
      populationId: String(row.population_id), drawId: String(row.draw_id),
      datasetRevisionId: String(row.dataset_revision_id), contractVersion: String(row.contract_version),
      idempotencyKey: String(row.idempotency_key), requestDigest: String(row.request_digest),
      contentDigest: String(row.content_digest), createdByUserId: String(row.created_by_user_id),
      createdBySubjectId: String(row.created_by_subject_id), createdAt: iso(row.study_created_at)
    },
    state: String(row.state), currentVersion: String(row.current_version),
    currentEventId: nullableString(row.current_event_id),
    currentEventDigest: nullableString(row.current_event_digest), stoppingRule,
    closureId: nullableString(row.closure_id), closureDigest: nullableString(row.closure_digest)
  });
}


export function rowToClosure(row: Record<string, unknown>): AnalysisStudyClosureArtifact | null {
  if (!row.close_id) return null;
  return {
    id: String(row.close_id), projectId: String(row.project_id), studyId: String(row.study_id),
    populationId: String(row.population_id), drawId: String(row.draw_id),
    datasetRevisionId: String(row.dataset_revision_id),
    stoppingRule: { kind: String(row.close_stopping_rule) as AnalysisStudyStoppingRule["kind"],
      closeAt: row.close_stopping_rule === "server_deadline" ? iso(row.close_at_frozen) : null } as AnalysisStudyStoppingRule,
    closeCause: String(row.close_cause) as AnalysisStudyClosureArtifact["closeCause"],
    closeActorUserId: nullableString(row.close_actor_user_id),
    closeActorSubjectId: nullableString(row.close_actor_subject_id),
    closeActorRole: String(row.close_actor_role) as AnalysisStudyClosureArtifact["closeActorRole"],
    closeReason: nullableString(row.close_reason), effectiveClosedAt: iso(row.effective_closed_at),
    recordedAt: iso(row.recorded_at), selectedItemCount: Number(row.closure_selected_item_count),
    viewedItemCount: Number(row.closure_viewed_item_count),
    completedItemCount: Number(row.closure_completed_item_count),
    viewSetDigest: String(row.view_set_digest), assessmentVersion: String(row.assessment_version) as typeof ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION,
    method: String(row.method), frozenFrameDigest: String(row.frozen_frame_digest),
    recomputedFrameDigest: nullableString(row.recomputed_frame_digest),
    frozenDrawDigest: String(row.frozen_draw_digest),
    recomputedDrawDigest: nullableString(row.recomputed_draw_digest),
    methodEligible: Boolean(row.method_eligible), frameReproducible: Boolean(row.frame_reproducible),
    drawComplete: Boolean(row.draw_complete), codingComplete: Boolean(row.coding_complete),
    closureItemCount: Number(row.closure_item_count),
    drawnFromPopulationId: String(row.drawn_from_population_id),
    representativeOfPopulationId: nullableString(row.representative_of_population_id),
    representativeReason: nullableString(row.representative_reason) as AnalysisStudyClosureArtifact["representativeReason"],
    assessmentDigest: String(row.assessment_digest), contentDigest: String(row.closure_content_digest),
    closureDigest: String(row.close_closure_digest), createdAt: iso(row.closure_created_at)
  };
}


export function rowToStudySummary(row: Record<string, unknown>): AnalysisStudySummary {
  return {
    study: rowToStudyProjection(row), selectedItemCount: Number(row.selected_item_count),
    viewedItemCount: Number(row.viewed_item_count), completedItemCount: Number(row.completed_item_count),
    closure: rowToClosure(row)
  };
}


export function rowToStudyItemProjection(row: Record<string, unknown>): AnalysisStudyItemProjection {
  return AnalysisStudyItemProjectionSchema.parse({
    item: { id: String(row.id), projectId: String(row.project_id), studyId: String(row.study_id),
      drawItemId: String(row.draw_item_id), memberId: String(row.member_id),
      revisionItemId: String(row.revision_item_id), caseId: String(row.case_id),
      position: Number(row.position), contentDigest: String(row.content_digest), createdAt: iso(row.created_at) },
    state: String(row.item_state), currentVersion: String(row.current_version),
    currentEventId: nullableString(row.current_event_id), currentEventDigest: nullableString(row.current_event_digest),
    viewEventIds: textArray(row.view_event_ids), viewEventDigests: textArray(row.view_event_digests),
    activeFailureObservationEventIds: textArray(row.active_failure_observation_event_ids),
    activeFailureObservationEventDigests: textArray(row.active_failure_observation_event_digests),
    activeFailureAssignmentEventIds: nullableTextArray(row.active_failure_assignment_event_ids),
    activeFailureAssignmentEventDigests: nullableTextArray(row.active_failure_assignment_event_digests),
    activeNoFailureEventId: nullableString(row.active_no_failure_event_id),
    activeNoFailureEventDigest: nullableString(row.active_no_failure_event_digest),
    completionEventId: nullableString(row.completion_event_id),
    completionEventDigest: nullableString(row.completion_event_digest)
  });
}


export function rowToStudyEvent(row: Record<string, unknown>): AnalysisStudyEventArtifact {
  const common = { id: String(row.id), projectId: String(row.project_id), studyId: String(row.study_id),
    version: String(row.version), predecessorEventId: nullableString(row.predecessor_event_id),
    predecessorEventDigest: nullableString(row.predecessor_event_digest),
    actorUserId: nullableString(row.actor_user_id), actorSubjectId: nullableString(row.actor_subject_id),
    actorRole: String(row.actor_role), idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest), eventDigest: String(row.event_digest), occurredAt: iso(row.occurred_at),
    eventType: String(row.event_type), fromState: String(row.from_state), toState: String(row.to_state) };
  if (row.event_type === "coding_opened") return { ...common,
    eventType: "coding_opened", fromState: "draft", toState: "coding_open",
    stoppingRule: { kind: String(row.stopping_rule), closeAt: row.stopping_rule === "server_deadline" ? iso(row.close_at) : null } as AnalysisStudyStoppingRule,
    closeCause: null, closureId: null, closureDigest: null, expectedClosureDigest: null, reason: null } as AnalysisStudyEventArtifact;
  if (row.event_type === "coding_closed") return { ...common,
    eventType: "coding_closed", fromState: "coding_open", toState: "coding_closed", stoppingRule: null,
    closeCause: String(row.close_cause), closureId: String(row.closure_id),
    closureDigest: String(row.closure_digest), expectedClosureDigest: null,
    reason: nullableString(row.reason) } as AnalysisStudyEventArtifact;
  if (row.event_type === "study_completed") return { ...common,
    eventType: "study_completed", fromState: "coding_closed", toState: "completed", stoppingRule: null,
    closeCause: null, closureId: null, closureDigest: null,
    expectedClosureDigest: String(row.expected_closure_digest), reason: null } as AnalysisStudyEventArtifact;
  return { ...common, eventType: "study_abandoned",
    fromState: String(row.from_state), toState: "abandoned", stoppingRule: null, closeCause: null,
    closureId: null, closureDigest: null, expectedClosureDigest: null, reason: String(row.reason) } as AnalysisStudyEventArtifact;
}


export function rowToStudyItemEvent(row: Record<string, unknown>): AnalysisStudyItemEventArtifact {
  const common = { id: String(row.id), projectId: String(row.project_id), studyId: String(row.study_id),
    studyItemId: String(row.study_item_id), version: String(row.version),
    predecessorEventId: nullableString(row.predecessor_event_id),
    predecessorEventDigest: nullableString(row.predecessor_event_digest),
    actorUserId: String(row.actor_user_id), actorSubjectId: String(row.actor_subject_id),
    actorRole: String(row.actor_role), idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest), eventDigest: String(row.event_digest), occurredAt: iso(row.occurred_at) };
  const type = String(row.event_type);
  if (type === "failure_observed") return AnalysisStudyItemEventArtifactSchema.parse({ ...common,
    eventType: type, failureLabel: String(row.failure_label), rationale: String(row.rationale),
    evidenceAnchor: row.anchor_kind === "step" ? { kind: "step", stepIndex: Number(row.anchor_step_index) } : { kind: "case_output" } });
  if (type === "no_failure_observed") return AnalysisStudyItemEventArtifactSchema.parse({ ...common, eventType: type, rationale: String(row.rationale) });
  if (type === "coding_completed") return AnalysisStudyItemEventArtifactSchema.parse({ ...common, eventType: type });
  return AnalysisStudyItemEventArtifactSchema.parse({ ...common, eventType: type,
    targetEventId: String(row.target_event_id), targetEventDigest: String(row.target_event_digest),
    rationale: String(row.rationale) });
}


export function rowToTaxonomyArtifact(row: Record<string, unknown>): AnalysisFailureTaxonomyArtifact {
  return { id: String(row.id), projectId: String(row.project_id),
    contractVersion: String(row.contract_version) as typeof ANALYSIS_TAXONOMY_CONTRACT_VERSION,
    name: String(row.name), description: String(row.description),
    idempotencyKey: String(row.idempotency_key), requestDigest: String(row.request_digest),
    contentDigest: String(row.content_digest), createdByUserId: String(row.created_by_user_id),
    createdBySubjectId: String(row.created_by_subject_id), createdAt: iso(row.created_at) };
}


export function rowToTaxonomyRevision(row: Record<string, unknown>): AnalysisTaxonomyRevisionArtifact {
  return { id: String(row.id), projectId: String(row.project_id), taxonomyId: String(row.taxonomy_id),
    sequence: Number(row.sequence), predecessorRevisionId: nullableString(row.predecessor_revision_id),
    predecessorRevisionDigest: nullableString(row.predecessor_revision_digest), reason: String(row.reason),
    codeCount: Number(row.code_count), contentDigest: String(row.content_digest),
    revisionDigest: String(row.revision_digest), createdByUserId: String(row.created_by_user_id),
    createdBySubjectId: String(row.created_by_subject_id), idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest), createdAt: iso(row.created_at) };
}


export function rowToTaxonomyCode(row: Record<string, unknown>): AnalysisTaxonomyRevisionCodeArtifact {
  return { id: String(row.id), projectId: String(row.project_id), taxonomyId: String(row.taxonomy_id),
    taxonomyRevisionId: String(row.taxonomy_revision_id), codeId: String(row.code_id),
    position: Number(row.position), label: String(row.label), definition: String(row.definition),
    status: String(row.status) as AnalysisTaxonomyRevisionCodeArtifact["status"],
    entryDigest: String(row.entry_digest), createdAt: iso(row.created_at) };
}


export function rowToAssignmentEvent(row: Record<string, unknown>): AnalysisObservationAssignmentEventArtifact {
  const value = { id: String(row.id), projectId: String(row.project_id), taxonomyId: String(row.taxonomy_id),
    taxonomyRevisionId: String(row.taxonomy_revision_id),
    taxonomyRevisionSequence: Number(row.taxonomy_revision_sequence), studyId: String(row.study_id),
    studyItemId: String(row.study_item_id), observationEventId: String(row.observation_event_id),
    version: String(row.version), predecessorEventId: nullableString(row.predecessor_event_id),
    predecessorEventDigest: nullableString(row.predecessor_event_digest), eventType: String(row.event_type),
    codeId: nullableString(row.code_id), rationale: String(row.rationale), actorUserId: String(row.actor_user_id),
    actorSubjectId: String(row.actor_subject_id), actorRole: String(row.actor_role),
    idempotencyKey: String(row.idempotency_key), requestDigest: String(row.request_digest),
    eventDigest: String(row.event_digest), occurredAt: iso(row.occurred_at) };
  return value as AnalysisObservationAssignmentEventArtifact;
}


export function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}


export function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}


export function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}


export function nullableTextArray(value: unknown): (string | null)[] {
  return Array.isArray(value) ? value.map(nullableString) : [];
}
