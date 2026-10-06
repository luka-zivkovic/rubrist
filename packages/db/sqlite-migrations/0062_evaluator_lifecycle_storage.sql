-- Lifecycle storage is staged until exact candidate bundle and consumer guards land.
CREATE UNIQUE INDEX dataset_exposure_project_identity ON dataset_exposure_events(project_id,id);
CREATE TABLE evaluator_lifecycles (
 id TEXT NOT NULL,
 contract_version TEXT NOT NULL,
 project_id TEXT NOT NULL,
 criterion_id TEXT NOT NULL,
 criterion_version_id TEXT NOT NULL,
 skill_id TEXT NOT NULL,
 skill_version_id TEXT NOT NULL,
 promotion_id TEXT NOT NULL,
 governed_batch_id TEXT NOT NULL,
 governed_batch_digest TEXT NOT NULL,
 truth_dataset_revision_id TEXT NOT NULL,
 truth_revision_digest TEXT NOT NULL,
 truth_content_digest TEXT NOT NULL,
 truth_item_count INTEGER NOT NULL,
 regression_dataset_revision_id TEXT NOT NULL,
 regression_revision_digest TEXT NOT NULL,
 regression_content_digest TEXT NOT NULL,
 regression_item_count INTEGER NOT NULL,
 developer_exposure_event_id TEXT NOT NULL,
 created_by_user_id TEXT NOT NULL,
 created_by_subject_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(id),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 UNIQUE(project_id, criterion_id, skill_version_id),
 UNIQUE(project_id, developer_exposure_event_id),
 UNIQUE(project_id, id),
 UNIQUE(project_id, idempotency_key),
 UNIQUE(project_id, skill_version_id),
 FOREIGN KEY(project_id,created_by_subject_id) REFERENCES governed_reviewer_subjects(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(created_by_user_id) REFERENCES "user"(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,criterion_id) REFERENCES criteria(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,criterion_version_id) REFERENCES criterion_versions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,developer_exposure_event_id) REFERENCES dataset_exposure_events(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,governed_batch_id) REFERENCES governed_review_batches(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,promotion_id) REFERENCES analysis_criterion_promotions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,regression_dataset_revision_id) REFERENCES dataset_revisions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,skill_id) REFERENCES skills(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,truth_dataset_revision_id) REFERENCES dataset_revisions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(length(governed_batch_digest)=71 AND substr(governed_batch_digest,1,7)='sha256:' AND substr(governed_batch_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(truth_revision_digest)=71 AND substr(truth_revision_digest,1,7)='sha256:' AND substr(truth_revision_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(truth_content_digest)=71 AND substr(truth_content_digest,1,7)='sha256:' AND substr(truth_content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(regression_revision_digest)=71 AND substr(regression_revision_digest,1,7)='sha256:' AND substr(regression_revision_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(regression_content_digest)=71 AND substr(regression_content_digest,1,7)='sha256:' AND substr(regression_content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK ((truth_item_count = regression_item_count)),
 CHECK ((contract_version = 'rubrist/evaluator-lifecycle/v1')),
 CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 240))),
 CHECK (((regression_item_count >= 1) AND (regression_item_count <= 10000))),
 CHECK (((truth_item_count >= 1) AND (truth_item_count <= 10000)))
) STRICT;
CREATE TRIGGER evaluator_lifecycles_immutable BEFORE UPDATE ON evaluator_lifecycles BEGIN SELECT RAISE(ABORT,'immutable evaluator lifecycle evidence'); END;
CREATE TRIGGER evaluator_lifecycles_erase BEFORE DELETE ON evaluator_lifecycles WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'evaluator lifecycle deletion requires project erasure'); END;
CREATE TRIGGER evaluator_lifecycles_stage BEFORE INSERT ON evaluator_lifecycles BEGIN SELECT RAISE(ABORT,'evaluator lifecycle requires complete owning commands'); END;
CREATE TABLE evaluator_lifecycle_events (
 id TEXT NOT NULL,
 contract_version TEXT NOT NULL,
 lifecycle_id TEXT NOT NULL,
 project_id TEXT NOT NULL,
 criterion_id TEXT NOT NULL,
 skill_version_id TEXT NOT NULL,
 sequence INTEGER NOT NULL,
 transition TEXT NOT NULL,
 state TEXT NOT NULL,
 predecessor_event_id TEXT,
 predecessor_event_digest TEXT,
 activation_bundle_id TEXT,
 calibration_artifact_id TEXT,
 calibration_artifact_digest TEXT,
 calibration_evidence_digest TEXT,
 regression_run_id TEXT,
 regression_dataset_revision_id TEXT,
 replaced_skill_version_id TEXT,
 actor_user_id TEXT,
 actor_subject_id TEXT,
 actor_role TEXT NOT NULL,
 reason TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 PRIMARY KEY(id),
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
 UNIQUE(lifecycle_id, sequence),
 UNIQUE(project_id, id),
 UNIQUE(project_id, idempotency_key),
 FOREIGN KEY(project_id,actor_subject_id) REFERENCES governed_reviewer_subjects(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(actor_user_id) REFERENCES "user"(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,calibration_artifact_id) REFERENCES binary_calibration_artifacts(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,criterion_id) REFERENCES criteria(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,lifecycle_id) REFERENCES evaluator_lifecycles(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,predecessor_event_id) REFERENCES evaluator_lifecycle_events(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,regression_dataset_revision_id) REFERENCES dataset_revisions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,regression_run_id) REFERENCES regression_runs(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,replaced_skill_version_id) REFERENCES skill_versions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(length(predecessor_event_digest)=71 AND substr(predecessor_event_digest,1,7)='sha256:' AND substr(predecessor_event_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(calibration_artifact_digest)=71 AND substr(calibration_artifact_digest,1,7)='sha256:' AND substr(calibration_artifact_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(calibration_evidence_digest)=71 AND substr(calibration_evidence_digest,1,7)='sha256:' AND substr(calibration_evidence_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK ((actor_role IN ('owner', 'system'))),
 CHECK (((sequence = 1) = (transition = 'candidate_created'))),
 CHECK (((sequence = 1) = (predecessor_event_id IS NULL))),
 CHECK (((calibration_artifact_id IS NULL) = (regression_run_id IS NULL))),
 CHECK (((calibration_artifact_id IS NULL) = (regression_dataset_revision_id IS NULL))),
 CHECK ((((actor_role = 'owner') AND (actor_user_id IS NOT NULL) AND (actor_subject_id IS NOT NULL)) OR ((actor_role = 'system') AND (actor_user_id IS NULL) AND (actor_subject_id IS NULL)))),
 CHECK (((predecessor_event_id IS NULL) = (predecessor_event_digest IS NULL))),
 CHECK (((transition = 'candidate_created') = (state = 'candidate'))),
 CHECK (((transition = 'activated') = (state = 'active'))),
 CHECK (((transition = 'calibration_revoked') = (state = 'needs_review'))),
 CHECK (((transition = 'retired') = (state = 'retired'))),
 CHECK (((transition = 'activated') = (calibration_artifact_id IS NOT NULL))),
 CHECK (((calibration_artifact_id IS NULL) = (calibration_artifact_digest IS NULL))),
 CHECK (((calibration_artifact_id IS NULL) = (calibration_evidence_digest IS NULL))),
 CHECK ((contract_version = 'rubrist/evaluator-lifecycle-event/v1')),
 CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 240))),
 CHECK (((length(trim(reason)) >= 1) AND (length(trim(reason)) <= 5000))),
 CHECK ((sequence > 0)),
 CHECK ((state IN ('candidate', 'active', 'needs_review', 'retired'))),
 CHECK ((transition IN ('candidate_created', 'activated', 'calibration_revoked', 'retired')))
) STRICT;
CREATE TRIGGER evaluator_lifecycle_events_immutable BEFORE UPDATE ON evaluator_lifecycle_events BEGIN SELECT RAISE(ABORT,'immutable evaluator lifecycle evidence'); END;
CREATE TRIGGER evaluator_lifecycle_events_erase BEFORE DELETE ON evaluator_lifecycle_events WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'evaluator lifecycle deletion requires project erasure'); END;
CREATE TRIGGER evaluator_lifecycle_events_stage BEFORE INSERT ON evaluator_lifecycle_events BEGIN SELECT RAISE(ABORT,'evaluator lifecycle requires complete owning commands'); END;
CREATE INDEX evaluator_lifecycle_events_activation_idx ON evaluator_lifecycle_events (calibration_artifact_id) WHERE (transition = 'activated');
CREATE INDEX evaluator_lifecycle_events_head_idx ON evaluator_lifecycle_events (lifecycle_id, sequence DESC, id);
CREATE INDEX evaluator_lifecycles_lineage_idx ON evaluator_lifecycles (project_id, criterion_id, created_at, id);
CREATE VIEW evaluator_lifecycle_heads AS
 SELECT e.* FROM evaluator_lifecycle_events e WHERE NOT EXISTS(SELECT 1 FROM evaluator_lifecycle_events later WHERE later.lifecycle_id=e.lifecycle_id AND later.sequence>e.sequence);
CREATE VIEW evaluator_lifecycle_admissibility AS
 SELECT l.id lifecycle_id,l.project_id,l.skill_version_id,
 CASE WHEN h.id IS NULL OR h.state<>'active' OR h.calibration_artifact_id IS NULL THEN 'not_applicable'
 WHEN a.id IS NULL OR r.id IS NULL OR x.id IS NULL THEN 'unknown'
 WHEN a.status<>'complete' OR EXISTS(SELECT 1 FROM binary_calibration_revocation_events WHERE artifact_id=a.id) OR EXISTS(SELECT 1 FROM dataset_exposure_events e WHERE e.revision_id=r.dataset_revision_id AND e.occurred_at>=x.recorded_at AND (e.exposure_class='development' OR e.activity IN('declassify','analysis_authoring','rubric_authoring','prompt_tuning','example_selection','model_selection','development_run','regression_run'))) THEN 'revoked'
 ELSE 'admissible' END admissibility
 FROM evaluator_lifecycles l LEFT JOIN evaluator_lifecycle_heads h ON h.lifecycle_id=l.id
 LEFT JOIN binary_calibration_artifacts a ON a.id=h.calibration_artifact_id AND a.project_id=l.project_id
 LEFT JOIN binary_calibration_runs r ON r.id=a.run_id AND r.skill_version_id=l.skill_version_id
 LEFT JOIN binary_calibration_exposure_checks x ON x.id=r.completion_check_id AND x.phase='completion';
CREATE VIEW evaluator_lifecycle_contexts AS
 SELECT v.project_id,v.id skill_version_id,l.id lifecycle_id,h.id lifecycle_event_id,h.calibration_artifact_id,h.state,
 CASE WHEN l.id IS NULL THEN c.source_kind<>'analysis_promotion' ELSE h.id IS NOT NULL AND h.state<>'retired' END explicit_allowed,
 CASE WHEN l.id IS NULL THEN c.source_kind<>'analysis_promotion' ELSE h.state='active' AND a.admissibility='admissible' END implicit_allowed
 FROM skill_versions v JOIN criterion_versions cv ON cv.id=v.criterion_version_id AND cv.project_id=v.project_id JOIN criteria c ON c.id=cv.criterion_id AND c.project_id=cv.project_id
 LEFT JOIN evaluator_lifecycles l ON l.project_id=v.project_id AND l.skill_version_id=v.id
 LEFT JOIN evaluator_lifecycle_heads h ON h.lifecycle_id=l.id LEFT JOIN evaluator_lifecycle_admissibility a ON a.lifecycle_id=l.id;
