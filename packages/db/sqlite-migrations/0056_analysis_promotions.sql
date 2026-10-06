-- Accepted ADR-0010 promotion evidence. No evaluator or handoff is enabled here.
-- Abort conflicting historical native namespaces; never silently rewrite identities.
CREATE TABLE analysis_promotion_namespace_preflight (ok INTEGER CHECK(ok=1)) STRICT;
INSERT INTO analysis_promotion_namespace_preflight SELECT 0 FROM criteria WHERE stable_key LIKE 'analysis-failure-code:%';
DROP TABLE analysis_promotion_namespace_preflight;
CREATE TABLE analysis_criterion_promotions (
 id TEXT NOT NULL PRIMARY KEY,
 project_id TEXT NOT NULL,
 contract_version TEXT NOT NULL,
 study_id TEXT NOT NULL,
 study_closure_id TEXT NOT NULL,
 study_closure_digest TEXT NOT NULL,
 population_id TEXT NOT NULL,
 draw_id TEXT NOT NULL,
 source_dataset_revision_id TEXT NOT NULL,
 source_dataset_revision_content_digest TEXT NOT NULL,
 source_dataset_revision_digest TEXT NOT NULL,
 taxonomy_id TEXT NOT NULL,
 taxonomy_revision_id TEXT NOT NULL,
 taxonomy_revision_sequence INTEGER NOT NULL,
 taxonomy_revision_digest TEXT NOT NULL,
 code_id TEXT NOT NULL,
 code_entry_id TEXT NOT NULL,
 code_entry_digest TEXT NOT NULL,
 code_label TEXT NOT NULL,
 code_definition TEXT NOT NULL,
 criterion_id TEXT NOT NULL,
 criterion_version_id TEXT NOT NULL,
 criterion_stable_key TEXT NOT NULL,
 criterion_name TEXT NOT NULL,
 criterion_definition TEXT NOT NULL,
 criterion_digest TEXT NOT NULL,
 rationale TEXT NOT NULL,
 support_count INTEGER NOT NULL,
 support_set_digest TEXT NOT NULL,
 criterion_authoring_exposure_event_id TEXT NOT NULL,
 promoted_by_user_id TEXT NOT NULL,
 promoted_by_subject_id TEXT NOT NULL,
 promoter_role TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 handoff_version TEXT NOT NULL,
 handoff_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 created_command_token TEXT NOT NULL,
 CHECK(length(study_closure_digest)=71 AND substr(study_closure_digest,1,7)='sha256:' AND substr(study_closure_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(source_dataset_revision_content_digest)=71 AND substr(source_dataset_revision_content_digest,1,7)='sha256:' AND substr(source_dataset_revision_content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(source_dataset_revision_digest)=71 AND substr(source_dataset_revision_digest,1,7)='sha256:' AND substr(source_dataset_revision_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(taxonomy_revision_digest)=71 AND substr(taxonomy_revision_digest,1,7)='sha256:' AND substr(taxonomy_revision_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(code_entry_digest)=71 AND substr(code_entry_digest,1,7)='sha256:' AND substr(code_entry_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(criterion_digest)=71 AND substr(criterion_digest,1,7)='sha256:' AND substr(criterion_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(support_set_digest)=71 AND substr(support_set_digest,1,7)='sha256:' AND substr(support_set_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(handoff_digest)=71 AND substr(handoff_digest,1,7)='sha256:' AND substr(handoff_digest,8) NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(project_id,id),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 UNIQUE(project_id,id,created_command_token),
 UNIQUE(project_id,code_id),
 UNIQUE(project_id,criterion_id),
 UNIQUE(project_id,criterion_version_id),
 UNIQUE(project_id,criterion_authoring_exposure_event_id),
 UNIQUE(project_id,idempotency_key),
 FOREIGN KEY(project_id,study_id) REFERENCES analysis_studies(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,study_closure_id) REFERENCES analysis_study_closures(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,population_id) REFERENCES analysis_populations(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,draw_id) REFERENCES analysis_population_draws(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,source_dataset_revision_id) REFERENCES dataset_revisions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,taxonomy_id) REFERENCES analysis_failure_taxonomies(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,taxonomy_revision_id) REFERENCES analysis_failure_taxonomy_revisions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,code_id) REFERENCES analysis_failure_codes(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,code_entry_id) REFERENCES analysis_failure_taxonomy_revision_codes(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,criterion_id) REFERENCES criteria(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,promoted_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,id,created_command_token) REFERENCES analysis_promotion_finalizations(project_id,promotion_id,command_token) DEFERRABLE INITIALLY DEFERRED,
 CHECK(contract_version='analysis-criterion-promotion/v1'),
 CHECK(handoff_version='analysis-criterion-promotion-handoff/v1'),
 CHECK(promoter_role='owner'),
 CHECK(support_count BETWEEN 1 AND 1000),
 CHECK(taxonomy_revision_sequence BETWEEN 1 AND 10000),
 CHECK(length(code_definition) BETWEEN 1 AND 5000 AND code_definition=trim(code_definition)),
 CHECK(length(code_label) BETWEEN 1 AND 500 AND code_label=trim(code_label)),
 CHECK(length(criterion_definition) BETWEEN 1 AND 20000 AND criterion_definition=trim(criterion_definition)),
 CHECK(length(criterion_name) BETWEEN 1 AND 200 AND criterion_name=trim(criterion_name)),
 CHECK(length(criterion_stable_key) BETWEEN 1 AND 200 AND criterion_stable_key=trim(criterion_stable_key)),
 CHECK(length(rationale) BETWEEN 1 AND 5000 AND rationale=trim(rationale)),
 CHECK(length(idempotency_key) BETWEEN 1 AND 240 AND idempotency_key=trim(idempotency_key))
) STRICT;
CREATE TABLE analysis_criterion_promotion_supports (
 id TEXT NOT NULL PRIMARY KEY,
 project_id TEXT NOT NULL,
 promotion_id TEXT NOT NULL,
 position INTEGER NOT NULL,
 study_id TEXT NOT NULL,
 study_item_id TEXT NOT NULL,
 closure_id TEXT NOT NULL,
 closure_item_id TEXT NOT NULL,
 closure_item_digest TEXT NOT NULL,
 source_dataset_revision_id TEXT NOT NULL,
 source_dataset_revision_item_id TEXT NOT NULL,
 source_item_digest TEXT NOT NULL,
 observation_event_id TEXT NOT NULL,
 observation_event_digest TEXT NOT NULL,
 assignment_event_id TEXT NOT NULL,
 assignment_event_digest TEXT NOT NULL,
 observation_author_user_id TEXT NOT NULL,
 observation_author_subject_id TEXT NOT NULL,
 example_selection_exposure_event_id TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 CHECK(length(closure_item_digest)=71 AND substr(closure_item_digest,1,7)='sha256:' AND substr(closure_item_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(source_item_digest)=71 AND substr(source_item_digest,1,7)='sha256:' AND substr(source_item_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(observation_event_digest)=71 AND substr(observation_event_digest,1,7)='sha256:' AND substr(observation_event_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(assignment_event_digest)=71 AND substr(assignment_event_digest,1,7)='sha256:' AND substr(assignment_event_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 UNIQUE(project_id,id),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 UNIQUE(promotion_id,position),
 UNIQUE(promotion_id,observation_event_id),
 UNIQUE(project_id,example_selection_exposure_event_id),
 CHECK(position BETWEEN 0 AND 999),
 FOREIGN KEY(project_id,promotion_id) REFERENCES analysis_criterion_promotions(project_id,id),
 FOREIGN KEY(project_id,study_id) REFERENCES analysis_studies(project_id,id),
 FOREIGN KEY(project_id,study_item_id) REFERENCES analysis_study_items(project_id,id),
 FOREIGN KEY(project_id,closure_id) REFERENCES analysis_study_closures(project_id,id),
 FOREIGN KEY(project_id,closure_item_id) REFERENCES analysis_study_closure_items(project_id,id),
 FOREIGN KEY(project_id,source_dataset_revision_id) REFERENCES dataset_revisions(project_id,id),
 FOREIGN KEY(project_id,source_dataset_revision_item_id) REFERENCES dataset_revision_items(project_id,id),
 FOREIGN KEY(project_id,observation_event_id) REFERENCES analysis_study_item_events(project_id,id),
 FOREIGN KEY(project_id,assignment_event_id) REFERENCES analysis_observation_assignment_events(project_id,id),
 FOREIGN KEY(project_id,observation_author_subject_id) REFERENCES governed_reviewer_subjects(project_id,id)
) STRICT;
CREATE TABLE analysis_promotion_finalizations (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 promotion_id TEXT PRIMARY KEY NOT NULL,
 command_token TEXT NOT NULL,
 UNIQUE(project_id,promotion_id,command_token),
 FOREIGN KEY(project_id,promotion_id,command_token) REFERENCES analysis_criterion_promotions(project_id,id,created_command_token)
) STRICT;
CREATE TRIGGER analysis_criterion_promotions_immutable BEFORE UPDATE ON analysis_criterion_promotions BEGIN SELECT RAISE(ABORT,'immutable promotion evidence'); END;
CREATE TRIGGER analysis_criterion_promotions_erase BEFORE DELETE ON analysis_criterion_promotions WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'promotion deletion requires project erasure'); END;
CREATE TRIGGER analysis_criterion_promotion_supports_immutable BEFORE UPDATE ON analysis_criterion_promotion_supports BEGIN SELECT RAISE(ABORT,'immutable promotion evidence'); END;
CREATE TRIGGER analysis_criterion_promotion_supports_erase BEFORE DELETE ON analysis_criterion_promotion_supports WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'promotion deletion requires project erasure'); END;
CREATE TRIGGER analysis_promotion_finalizations_immutable BEFORE UPDATE ON analysis_promotion_finalizations BEGIN SELECT RAISE(ABORT,'immutable promotion evidence'); END;
CREATE TRIGGER analysis_promotion_finalizations_erase BEFORE DELETE ON analysis_promotion_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'promotion deletion requires project erasure'); END;
CREATE TRIGGER analysis_promotion_insert BEFORE INSERT ON analysis_criterion_promotions BEGIN
 SELECT CASE WHEN NEW.created_at IS NOT sqlite_command_time() OR NEW.created_command_token IS NOT sqlite_command_token() THEN RAISE(ABORT,'promotion requires owning command') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM criteria WHERE id=NEW.criterion_id) OR EXISTS(SELECT 1 FROM criterion_versions WHERE id=NEW.criterion_version_id) THEN RAISE(ABORT,'promotion must create a new criterion') END;
END;
CREATE TRIGGER analysis_promotion_support_insert BEFORE INSERT ON analysis_criterion_promotion_supports BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_criterion_promotions p WHERE p.id=NEW.promotion_id AND p.project_id=NEW.project_id AND p.created_command_token=sqlite_command_token() AND p.created_at=NEW.created_at AND p.study_id=NEW.study_id AND p.study_closure_id=NEW.closure_id AND p.source_dataset_revision_id=NEW.source_dataset_revision_id AND NEW.position<p.support_count) OR EXISTS(SELECT 1 FROM analysis_promotion_finalizations WHERE promotion_id=NEW.promotion_id) THEN RAISE(ABORT,'support requires unfinalized owning promotion') END;
END;
CREATE TRIGGER analysis_promotion_finalize BEFORE INSERT ON analysis_promotion_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM analysis_criterion_promotions WHERE id=NEW.promotion_id AND project_id=NEW.project_id AND created_command_token=NEW.command_token) THEN RAISE(ABORT,'promotion finalizer requires owning command') END;
 SELECT CASE WHEN NOT analysis_promotion_bundle_valid_v1(NEW.project_id,NEW.promotion_id) THEN RAISE(ABORT,'promotion requires exact complete criterion support and exposure evidence') END;
END;
DROP TRIGGER criterion_native_stage;
CREATE TRIGGER analysis_promotion_criterion_insert BEFORE INSERT ON criteria BEGIN
 SELECT CASE WHEN NEW.source_kind='native' AND substr(NEW.stable_key,1,22)='analysis-failure-code:' THEN RAISE(ABORT,'reserved analysis promotion namespace') END;
 SELECT CASE WHEN NEW.source_kind='analysis_promotion' AND NOT EXISTS(SELECT 1 FROM analysis_criterion_promotions p WHERE p.project_id=NEW.project_id AND p.criterion_id=NEW.id AND p.criterion_stable_key=NEW.stable_key AND p.promoted_by_user_id=NEW.created_by_user_id AND p.created_at=NEW.created_at AND p.created_command_token=sqlite_command_token() AND NOT EXISTS(SELECT 1 FROM analysis_promotion_finalizations WHERE promotion_id=p.id)) THEN RAISE(ABORT,'criterion requires unfinalized owning promotion') END;
END;
CREATE TRIGGER analysis_promotion_version_insert BEFORE INSERT ON criterion_versions WHEN NEW.source_kind='analysis_promotion' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_criterion_promotions p WHERE p.project_id=NEW.project_id AND p.criterion_id=NEW.criterion_id AND p.criterion_version_id=NEW.id AND NEW.revision=1 AND p.criterion_name=NEW.name AND p.criterion_definition=NEW.definition AND p.criterion_digest=NEW.criterion_digest AND p.promoted_by_user_id=NEW.created_by_user_id AND p.created_at=NEW.created_at AND p.created_command_token=sqlite_command_token() AND NOT EXISTS(SELECT 1 FROM analysis_promotion_finalizations WHERE promotion_id=p.id)) THEN RAISE(ABORT,'criterion version requires unfinalized owning promotion') END;
END;
CREATE TRIGGER analysis_promotion_skill_stage BEFORE INSERT ON skills WHEN EXISTS(SELECT 1 FROM criteria WHERE id=NEW.criterion_id AND source_kind='analysis_promotion') BEGIN SELECT RAISE(ABORT,'promoted evaluator lifecycle is staged'); END;
CREATE TRIGGER analysis_promotion_skill_version_stage BEFORE INSERT ON skill_versions WHEN EXISTS(SELECT 1 FROM criteria WHERE id=NEW.criterion_id AND source_kind='analysis_promotion') BEGIN SELECT RAISE(ABORT,'promoted evaluator lifecycle is staged'); END;
CREATE TRIGGER analysis_promotion_exposure_insert BEFORE INSERT ON dataset_exposure_events WHEN NEW.evidence_ref_kind='analysis_criterion_promotion' OR NEW.idempotency_key LIKE 'analysis-promotion:%' BEGIN
 SELECT CASE WHEN NEW.evidence_ref_kind IS NOT 'analysis_criterion_promotion' OR NOT EXISTS(SELECT 1 FROM analysis_criterion_promotions p WHERE p.project_id=NEW.project_id AND p.id=NEW.evidence_ref_id AND p.created_command_token=sqlite_command_token() AND NOT EXISTS(SELECT 1 FROM analysis_promotion_finalizations WHERE promotion_id=p.id) AND (p.criterion_authoring_exposure_event_id=NEW.id OR EXISTS(SELECT 1 FROM analysis_criterion_promotion_supports s WHERE s.promotion_id=p.id AND s.example_selection_exposure_event_id=NEW.id))) THEN RAISE(ABORT,'promotion exposure requires preallocated unfinalized owning bundle') END;
END;
CREATE TRIGGER analysis_promotion_batch_committed BEFORE INSERT ON governed_review_batches WHEN EXISTS(SELECT 1 FROM criterion_versions WHERE id=NEW.criterion_version_id AND source_kind='analysis_promotion') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_criterion_promotions p JOIN analysis_promotion_finalizations f ON f.promotion_id=p.id WHERE p.project_id=NEW.project_id AND p.criterion_version_id=NEW.criterion_version_id AND p.created_command_token<>sqlite_command_token()) THEN RAISE(ABORT,'governed batch requires previously committed promotion') END;
END;
CREATE TRIGGER analysis_promotion_review_item_boundary BEFORE INSERT ON governed_review_items WHEN EXISTS(SELECT 1 FROM dataset_revisions WHERE id=NEW.source_revision_id AND source_kind='analysis_population') BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_criterion_promotions p JOIN analysis_promotion_finalizations f ON f.promotion_id=p.id WHERE p.project_id=NEW.project_id AND p.source_dataset_revision_id=NEW.source_revision_id) THEN RAISE(ABORT,'analysis review item requires completed criterion promotion') END;
END;
-- The evidence namespace cannot be evaded by using an unrelated reference/key.
CREATE TRIGGER analysis_promotion_exposure_boundary BEFORE INSERT ON dataset_exposure_events WHEN NEW.activity IN('criterion_authoring','example_selection') AND EXISTS(SELECT 1 FROM dataset_revisions WHERE id=NEW.revision_id AND source_kind='analysis_population') AND NEW.evidence_ref_kind IS NOT 'analysis_criterion_promotion' BEGIN SELECT RAISE(ABORT,'analysis promotion development exposure requires exact promotion evidence'); END;
