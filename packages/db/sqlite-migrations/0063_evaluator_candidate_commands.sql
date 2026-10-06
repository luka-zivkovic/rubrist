-- Exact candidate copies and execution boundaries are enabled together.
CREATE TABLE evaluator_candidate_claims (
 lifecycle_id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 truth_revision_id TEXT NOT NULL,regression_revision_id TEXT NOT NULL UNIQUE,skill_version_id TEXT NOT NULL UNIQUE,skill_id TEXT NOT NULL,
 criterion_id TEXT NOT NULL,criterion_version_id TEXT NOT NULL,governed_batch_id TEXT NOT NULL,actor_user_id TEXT NOT NULL,actor_subject_id TEXT NOT NULL,
 command_token TEXT NOT NULL UNIQUE,
 UNIQUE(project_id,lifecycle_id,command_token),
 FOREIGN KEY(project_id,lifecycle_id,command_token) REFERENCES evaluator_lifecycle_finalizations(project_id,lifecycle_id,command_token) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE evaluator_lifecycle_finalizations (
 lifecycle_id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,command_token TEXT NOT NULL,
 UNIQUE(project_id,lifecycle_id,command_token),
 FOREIGN KEY(project_id,lifecycle_id) REFERENCES evaluator_lifecycles(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,lifecycle_id,command_token) REFERENCES evaluator_candidate_claims(project_id,lifecycle_id,command_token) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE VIEW evaluator_candidate_open_claims AS SELECT q.* FROM evaluator_candidate_claims q WHERE q.command_token=sqlite_command_token() AND NOT EXISTS(SELECT 1 FROM evaluator_lifecycle_finalizations WHERE lifecycle_id=q.lifecycle_id);
CREATE TRIGGER evaluator_candidate_claim_insert BEFORE INSERT ON evaluator_candidate_claims BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR EXISTS(SELECT 1 FROM dataset_revisions WHERE id=NEW.regression_revision_id) OR EXISTS(SELECT 1 FROM skill_versions WHERE id=NEW.skill_version_id) OR EXISTS(SELECT 1 FROM evaluator_lifecycles WHERE id=NEW.lifecycle_id) THEN RAISE(ABORT,'candidate claim requires fresh identities in owning command') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM project_members m JOIN governed_reviewer_subjects s ON s.project_id=m.project_id AND s.account_user_id=m.user_id WHERE m.project_id=NEW.project_id AND m.user_id=NEW.actor_user_id AND m.role='owner' AND s.id=NEW.actor_subject_id) THEN RAISE(ABORT,'candidate claim requires live owner') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_criterion_promotions p JOIN analysis_promotion_finalizations pf ON pf.promotion_id=p.id JOIN governed_review_batches b ON b.project_id=p.project_id AND b.criterion_version_id=p.criterion_version_id JOIN governed_review_batch_states st ON st.batch_id=b.id AND st.state='frozen' JOIN governed_review_batch_events e ON e.batch_id=b.id AND e.event_kind='frozen' JOIN dataset_revisions r ON r.id=e.dataset_revision_id AND r.project_id=b.project_id JOIN dataset_revision_finalizations f ON f.revision_id=r.id WHERE p.project_id=NEW.project_id AND p.criterion_id=NEW.criterion_id AND p.criterion_version_id=NEW.criterion_version_id AND b.id=NEW.governed_batch_id AND b.role_intent IN('analysis_authoring','iterative_development') AND r.id=NEW.truth_revision_id AND r.criterion_version_id=NEW.criterion_version_id AND r.role IN('analysis_authoring','iterative_development') AND r.provenance_level='governed_blind' AND r.item_count BETWEEN 1 AND 10000) THEN RAISE(ABORT,'candidate claim requires exact frozen promoted truth') END;
END;
CREATE TRIGGER evaluator_candidate_claims_immutable BEFORE UPDATE ON evaluator_candidate_claims BEGIN SELECT RAISE(ABORT,'immutable candidate bundle'); END;
CREATE TRIGGER evaluator_candidate_claims_erase BEFORE DELETE ON evaluator_candidate_claims WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'candidate bundle deletion requires project erasure'); END;
CREATE TRIGGER evaluator_lifecycle_finalizations_immutable BEFORE UPDATE ON evaluator_lifecycle_finalizations BEGIN SELECT RAISE(ABORT,'immutable candidate bundle'); END;
CREATE TRIGGER evaluator_lifecycle_finalizations_erase BEFORE DELETE ON evaluator_lifecycle_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'candidate bundle deletion requires project erasure'); END;
DROP TRIGGER dataset_revision_finalize;
CREATE TRIGGER dataset_revision_finalize BEFORE INSERT ON dataset_revision_finalizations
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dataset_revisions r WHERE r.project_id=NEW.project_id AND r.id=NEW.revision_id AND r.item_count=(SELECT count(*) FROM dataset_revision_items WHERE revision_id=r.id)
    AND sqlite_dataset_content_digest((SELECT json_group_array(item_digest) FROM dataset_revision_items WHERE revision_id=r.id))=r.content_digest
    AND sqlite_dataset_revision_digest(r.role,(SELECT json_group_array(item_digest) FROM dataset_revision_items WHERE revision_id=r.id))=r.revision_digest
    AND (r.item_count=0 OR r.item_count=(SELECT max(position)+1 FROM dataset_revision_items WHERE revision_id=r.id))) THEN RAISE(ABORT,'dataset revision bundle mismatch') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims WHERE project_id=NEW.project_id AND regression_revision_id=NEW.revision_id) AND NOT EXISTS(SELECT 1 FROM dataset_exposure_events WHERE project_id=NEW.project_id AND revision_id=NEW.revision_id AND kind='created' AND exposure_class='lineage' AND activity='revision_create') THEN RAISE(ABORT,'dataset revision creation exposure required') END;
END;
DROP TRIGGER dataset_golden_finalize;
CREATE TRIGGER dataset_golden_finalize BEFORE INSERT ON dataset_revision_finalizations WHEN NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims WHERE project_id=NEW.project_id AND regression_revision_id=NEW.revision_id) AND (EXISTS(SELECT 1 FROM dataset_revisions WHERE id=NEW.revision_id AND role='regression_golden')) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM dataset_revision_items WHERE revision_id=NEW.revision_id AND (source_golden_entry_id IS NULL OR reference_label IS NULL)) THEN RAISE(ABORT,'golden revision requires registry references') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dataset_exposure_events WHERE revision_id=NEW.revision_id AND kind='legacy_pretracking' AND exposure_class='development' AND activity='legacy_import') THEN RAISE(ABORT,'golden revision requires visible exposure') END;
END;
DROP TRIGGER dataset_revision_governed_finalize;
CREATE TRIGGER dataset_revision_governed_finalize BEFORE INSERT ON dataset_revision_finalizations WHEN NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims WHERE project_id=NEW.project_id AND regression_revision_id=NEW.revision_id) AND (EXISTS(SELECT 1 FROM dataset_revisions WHERE id=NEW.revision_id AND provenance_level IN('governed_blind','imported_self_attested','imported_verified_attested'))) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM dataset_revisions r WHERE r.id=NEW.revision_id AND r.item_count>0 AND r.criterion_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dataset_revision_items i WHERE i.revision_id=r.id AND NOT EXISTS(SELECT 1 FROM governed_dataset_truth_links t WHERE t.dataset_revision_item_id=i.id AND t.dataset_revision_id=r.id AND ((r.provenance_level='governed_blind' AND t.source_kind IN('governed_labels','adjudication')) OR (r.provenance_level=t.resolution_kind AND t.source_kind='imported_truth'))))) THEN RAISE(ABORT,'claimed revision provenance requires complete authoritative truth links') END;
END;
DROP TRIGGER dataset_revision_native_truth_freeze;
CREATE TRIGGER dataset_revision_native_truth_freeze BEFORE INSERT ON dataset_revision_finalizations WHEN NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims WHERE project_id=NEW.project_id AND regression_revision_id=NEW.revision_id) AND (EXISTS(SELECT 1 FROM dataset_revisions WHERE id=NEW.revision_id AND provenance_level='governed_blind')) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_batch_events WHERE dataset_revision_id=NEW.revision_id AND project_id=NEW.project_id AND event_kind='frozen' AND occurred_at=sqlite_command_time() AND created_command_token=sqlite_command_token()) THEN RAISE(ABORT,'native governed revision requires same-command frozen batch') END;
END;
DROP TRIGGER dataset_revision_blind_payload_finalize;
CREATE TRIGGER dataset_revision_blind_payload_finalize BEFORE INSERT ON dataset_revision_finalizations WHEN NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims WHERE project_id=NEW.project_id AND regression_revision_id=NEW.revision_id) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM dataset_revision_items i WHERE i.revision_id=NEW.revision_id AND json_type(i.payload_snapshot,'$.metadata') IS NULL AND NOT EXISTS(SELECT 1 FROM governed_dataset_truth_links t WHERE t.dataset_revision_item_id=i.id AND t.dataset_revision_id=i.revision_id AND t.project_id=i.project_id)) THEN RAISE(ABORT,'metadata-free revision payload requires authoritative native or imported truth') END;
END;
CREATE TRIGGER evaluator_candidate_revision_insert BEFORE INSERT ON dataset_revisions WHEN EXISTS(SELECT 1 FROM evaluator_candidate_claims WHERE regression_revision_id=NEW.id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims q JOIN dataset_revisions truth ON truth.id=q.truth_revision_id WHERE q.regression_revision_id=NEW.id AND q.project_id=NEW.project_id AND NEW.role='regression_golden' AND NEW.source_kind='golden_snapshot' AND NEW.provenance_level='governed_blind' AND NEW.criterion_version_id=q.criterion_version_id AND NEW.series_id='candidate-regression:'||q.project_id||':'||q.criterion_version_id AND NEW.idempotency_key='candidate-regression:'||q.lifecycle_id AND NEW.created_by_user_id=q.actor_user_id AND NEW.item_count=truth.item_count AND NEW.created_at=sqlite_command_time() AND NEW.source_dataset_id IS NULL AND NEW.analysis_population_id IS NULL) THEN RAISE(ABORT,'candidate regression revision identity mismatch') END;
END;
CREATE TRIGGER evaluator_candidate_copy_item BEFORE INSERT ON dataset_revision_items WHEN EXISTS(SELECT 1 FROM evaluator_candidate_claims WHERE regression_revision_id=NEW.revision_id) BEGIN
 SELECT CASE WHEN NEW.source_case_id IS NOT NULL OR NEW.source_trace_id IS NOT NULL OR NEW.source_dataset_item_id IS NOT NULL OR NEW.source_golden_entry_id IS NOT NULL OR NEW.note IS NOT NULL OR NEW.reference_fail_step IS NOT NULL OR NEW.created_at IS NOT sqlite_command_time() THEN RAISE(ABORT,'candidate copy cannot add source metadata') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims q JOIN dataset_revision_items i ON i.project_id=q.project_id AND i.revision_id=q.truth_revision_id AND i.position=NEW.position JOIN governed_dataset_truth_links t ON t.project_id=i.project_id AND t.dataset_revision_id=i.revision_id AND t.dataset_revision_item_id=i.id AND t.resolved_label=i.reference_label WHERE q.regression_revision_id=NEW.revision_id AND q.project_id=NEW.project_id AND i.input_digest=NEW.input_digest AND i.payload_snapshot=NEW.payload_snapshot AND i.reference_label=NEW.reference_label AND sqlite_lifecycle_payload_roundtrip(i.payload_snapshot)=1 AND governed_canonical_json_v1(NEW.reference_provenance)=governed_canonical_json_v1(json_object('kind','dataset_claim','sourceId',t.id,'verdictIds',json('[]'),'actorUserIds',json('[]'),'basis','Governed nonsealed truth copied into an immutable known-failure regression snapshot; not sealed calibration evidence.'))) THEN RAISE(ABORT,'candidate regression must copy exact governed truth') END;
END;
CREATE TRIGGER evaluator_candidate_copy_finalize BEFORE INSERT ON dataset_revision_finalizations WHEN EXISTS(SELECT 1 FROM evaluator_candidate_claims WHERE regression_revision_id=NEW.revision_id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims q JOIN dataset_revisions r ON r.id=q.regression_revision_id JOIN dataset_revisions truth ON truth.id=q.truth_revision_id WHERE q.project_id=NEW.project_id AND q.regression_revision_id=NEW.revision_id AND r.item_count=truth.item_count AND r.item_count=(SELECT count(*) FROM dataset_revision_items WHERE revision_id=r.id) AND truth.item_count=(SELECT count(*) FROM governed_dataset_truth_links WHERE dataset_revision_id=truth.id AND resolved_label IN('pass','fail'))) THEN RAISE(ABORT,'candidate regression must contain complete truth') END;
END;
DROP TRIGGER analysis_promotion_skill_stage;
CREATE TRIGGER analysis_promotion_skill_stage BEFORE INSERT ON skills WHEN EXISTS(SELECT 1 FROM criteria WHERE id=NEW.criterion_id AND source_kind='analysis_promotion') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims q WHERE q.project_id=NEW.project_id AND q.skill_id=NEW.id AND q.criterion_id=NEW.criterion_id AND q.actor_user_id=NEW.owner_user_id AND NEW.status='calibrating' AND NEW.is_starter=0 AND NEW.created_at=sqlite_command_time()) OR EXISTS(SELECT 1 FROM skills WHERE project_id=NEW.project_id AND criterion_id=NEW.criterion_id) THEN RAISE(ABORT,'promoted evaluator requires unfinalized candidate claim') END;
END;
DROP TRIGGER analysis_promotion_skill_version_stage;
CREATE TRIGGER analysis_promotion_skill_version_stage BEFORE INSERT ON skill_versions WHEN EXISTS(SELECT 1 FROM criteria WHERE id=NEW.criterion_id AND source_kind='analysis_promotion') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims q WHERE q.project_id=NEW.project_id AND q.skill_id=NEW.skill_id AND q.skill_version_id=NEW.id AND q.criterion_id=NEW.criterion_id AND q.criterion_version_id=NEW.criterion_version_id AND q.regression_revision_id=NEW.regression_dataset_revision_id AND q.actor_user_id=NEW.created_by_user_id AND q.actor_subject_id=NEW.created_by_subject_id AND NEW.developer_identity_status='recorded' AND NEW.status='calibrating' AND NEW.verdict_kind='binary' AND NEW.created_at=sqlite_command_time()) THEN RAISE(ABORT,'promoted evaluator requires unfinalized candidate claim') END;
END;
CREATE TRIGGER evaluator_candidate_exposure BEFORE INSERT ON dataset_exposure_events WHEN NEW.evidence_ref_kind='evaluator_lifecycle' OR NEW.idempotency_key LIKE 'candidate-authoring:%' BEGIN
 SELECT CASE WHEN NEW.evidence_ref_kind IS NOT 'evaluator_lifecycle' OR NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims q WHERE q.project_id=NEW.project_id AND q.lifecycle_id=NEW.evidence_ref_id AND q.truth_revision_id=NEW.revision_id) THEN RAISE(ABORT,'candidate exposure requires owning unfinalized claim') END;
END;
CREATE TRIGGER evaluator_lifecycle_insert BEFORE INSERT ON evaluator_lifecycles BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims WHERE lifecycle_id=NEW.id AND project_id=NEW.project_id AND skill_version_id=NEW.skill_version_id) THEN RAISE(ABORT,'lifecycle requires owning unfinalized candidate claim') END;
END;
CREATE TRIGGER evaluator_lifecycle_seed_insert BEFORE INSERT ON evaluator_lifecycle_events BEGIN
 SELECT CASE WHEN NEW.sequence<>1 OR NEW.transition<>'candidate_created' THEN RAISE(ABORT,'lifecycle transitions are staged') END;
 SELECT CASE WHEN NEW.occurred_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims WHERE lifecycle_id=NEW.lifecycle_id AND project_id=NEW.project_id AND skill_version_id=NEW.skill_version_id) THEN RAISE(ABORT,'seed requires owning unfinalized candidate claim') END;
END;
CREATE TRIGGER evaluator_lifecycle_finalize BEFORE INSERT ON evaluator_lifecycle_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM evaluator_candidate_open_claims WHERE project_id=NEW.project_id AND lifecycle_id=NEW.lifecycle_id AND command_token=NEW.command_token) OR analysis_lifecycle_bundle_valid_v1(NEW.project_id,NEW.lifecycle_id)=0 THEN RAISE(ABORT,'candidate lifecycle bundle mismatch') END;
END;
CREATE TRIGGER evaluator_candidate_pointer_update BEFORE UPDATE ON criterion_regression_revisions WHEN EXISTS(SELECT 1 FROM evaluator_candidate_claims q JOIN evaluator_lifecycle_finalizations f ON f.lifecycle_id=q.lifecycle_id WHERE q.project_id=OLD.project_id AND q.criterion_version_id=OLD.criterion_version_id AND q.command_token=sqlite_command_token()) BEGIN SELECT RAISE(ABORT,'finalized candidate pointer cannot change in its command'); END;
CREATE TRIGGER evaluator_candidate_pointer_delete BEFORE DELETE ON criterion_regression_revisions WHEN EXISTS(SELECT 1 FROM evaluator_candidate_claims q JOIN evaluator_lifecycle_finalizations f ON f.lifecycle_id=q.lifecycle_id WHERE q.project_id=OLD.project_id AND q.criterion_version_id=OLD.criterion_version_id AND q.command_token=sqlite_command_token()) BEGIN SELECT RAISE(ABORT,'finalized candidate pointer cannot change in its command'); END;
CREATE TABLE evaluator_execution_authorizations__new (
  id TEXT PRIMARY KEY NOT NULL, contract_version TEXT NOT NULL CHECK(contract_version='rubrist/evaluator-execution-authorization/v1'),
  project_id TEXT NOT NULL, skill_version_id TEXT NOT NULL,
  execution_context TEXT NOT NULL CHECK(execution_context IN ('implicit_production','manual_import','scheduled_import','suite_publication','trace_test','release_gate','explicit_nonproduction_dataset','governed_nonsealed_evaluation','binary_calibration_evidence','candidate_regression_evidence')),
  lifecycle_event_id TEXT,
  calibration_artifact_id TEXT,
  resource_kind TEXT NOT NULL CHECK(length(resource_kind) BETWEEN 1 AND 120),
  resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 4096),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 240),
  content_digest TEXT NOT NULL, authorized_at TEXT NOT NULL,
  UNIQUE(project_id,idempotency_key), UNIQUE(project_id,id),
  FOREIGN KEY(project_id,lifecycle_event_id) REFERENCES evaluator_lifecycle_events(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,calibration_artifact_id) REFERENCES binary_calibration_artifacts(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE
) STRICT;
INSERT INTO evaluator_execution_authorizations__new(rowid,id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest,authorized_at) SELECT rowid,id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest,authorized_at FROM evaluator_execution_authorizations;
CREATE TEMP TABLE candidate_authorization_copy_assert(ok INTEGER CHECK(ok=1));
INSERT INTO candidate_authorization_copy_assert SELECT (SELECT count(*) FROM evaluator_execution_authorizations)=(SELECT count(*) FROM evaluator_execution_authorizations__new);
INSERT INTO candidate_authorization_copy_assert SELECT NOT EXISTS(SELECT rowid,id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest,authorized_at FROM evaluator_execution_authorizations EXCEPT SELECT rowid,id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest,authorized_at FROM evaluator_execution_authorizations__new);
DROP TABLE evaluator_execution_authorizations;
CREATE TABLE evaluator_execution_authorizations (
  id TEXT PRIMARY KEY NOT NULL, contract_version TEXT NOT NULL CHECK(contract_version='rubrist/evaluator-execution-authorization/v1'),
  project_id TEXT NOT NULL, skill_version_id TEXT NOT NULL,
  execution_context TEXT NOT NULL CHECK(execution_context IN ('implicit_production','manual_import','scheduled_import','suite_publication','trace_test','release_gate','explicit_nonproduction_dataset','governed_nonsealed_evaluation','binary_calibration_evidence','candidate_regression_evidence')),
  lifecycle_event_id TEXT,
  calibration_artifact_id TEXT,
  resource_kind TEXT NOT NULL CHECK(length(resource_kind) BETWEEN 1 AND 120),
  resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 4096),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 240),
  content_digest TEXT NOT NULL, authorized_at TEXT NOT NULL,
  UNIQUE(project_id,idempotency_key), UNIQUE(project_id,id),
  FOREIGN KEY(project_id,lifecycle_event_id) REFERENCES evaluator_lifecycle_events(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,calibration_artifact_id) REFERENCES binary_calibration_artifacts(project_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE
) STRICT;
INSERT INTO evaluator_execution_authorizations(rowid,id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest,authorized_at) SELECT rowid,id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest,authorized_at FROM evaluator_execution_authorizations__new;
INSERT INTO candidate_authorization_copy_assert SELECT (SELECT count(*) FROM evaluator_execution_authorizations)=(SELECT count(*) FROM evaluator_execution_authorizations__new);
INSERT INTO candidate_authorization_copy_assert SELECT NOT EXISTS(SELECT rowid,id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest,authorized_at FROM evaluator_execution_authorizations__new EXCEPT SELECT rowid,id,contract_version,project_id,skill_version_id,execution_context,lifecycle_event_id,calibration_artifact_id,resource_kind,resource_id,idempotency_key,content_digest,authorized_at FROM evaluator_execution_authorizations);
DROP TABLE evaluator_execution_authorizations__new;
DROP TABLE candidate_authorization_copy_assert;
CREATE TRIGGER execution_authorization_immutable BEFORE UPDATE ON evaluator_execution_authorizations BEGIN SELECT RAISE(ABORT,'immutable execution authorization'); END;
CREATE TRIGGER execution_authorization_no_delete BEFORE DELETE ON evaluator_execution_authorizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'execution authorization deletion requires project erasure'); END;
CREATE TRIGGER execution_authorization_validate BEFORE INSERT ON evaluator_execution_authorizations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM evaluator_lifecycle_contexts WHERE project_id=NEW.project_id AND skill_version_id=NEW.skill_version_id AND (CASE WHEN NEW.execution_context IN('explicit_nonproduction_dataset','governed_nonsealed_evaluation','binary_calibration_evidence','candidate_regression_evidence') THEN explicit_allowed ELSE implicit_allowed END)=1 AND lifecycle_event_id IS NEW.lifecycle_event_id AND calibration_artifact_id IS NEW.calibration_artifact_id) THEN RAISE(ABORT,'evaluator execution requires eligible current lifecycle head') END;
 SELECT CASE WHEN NEW.authorized_at IS NOT sqlite_command_time() OR NEW.content_digest IS NOT governed_content_v1_digest('evaluator-execution-authorization/v1',json_object('projectId',NEW.project_id,'skillVersionId',NEW.skill_version_id,'context',NEW.execution_context,'lifecycleEventId',NEW.lifecycle_event_id,'calibrationArtifactId',NEW.calibration_artifact_id,'resourceKind',NEW.resource_kind,'resourceId',NEW.resource_id)) THEN RAISE(ABORT,'execution authorization digest or command time mismatch') END;
END;
CREATE INDEX evaluator_execution_authorizations_version_idx ON evaluator_execution_authorizations(project_id,skill_version_id,authorized_at,id);
CREATE TRIGGER suite_manifest_lifecycle BEFORE INSERT ON evaluator_suite_manifests BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(CAST(NEW.canonical_bytes AS TEXT),'$.members') member WHERE NOT EXISTS(SELECT 1 FROM evaluator_lifecycle_contexts WHERE project_id=NEW.project_id AND skill_version_id=json_extract(member.value,'$.skillVersionId') AND implicit_allowed=1)) THEN RAISE(ABORT,'suite publication requires eligible lifecycle') END;
END;
DROP TRIGGER evaluator_lifecycles_stage;
DROP TRIGGER evaluator_lifecycle_events_stage;

-- Match PostgreSQL 0003 authorship declaration semantics for future rows.
CREATE TRIGGER skill_version_declared_authorship BEFORE INSERT ON skill_versions WHEN NEW.rubric_provenance_declared=1 AND NEW.rubric_provenance='unspecified' BEGIN SELECT RAISE(ABORT,'declared evaluator authorship cannot be unspecified'); END;
