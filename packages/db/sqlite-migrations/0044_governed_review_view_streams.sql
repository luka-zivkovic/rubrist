-- Initial governed streams: open/abandon and exact blind-view events.
CREATE TABLE governed_review_batch_events (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 batch_id TEXT NOT NULL,
 sequence INTEGER NOT NULL,
 state_version INTEGER NOT NULL,
 expected_previous_state_version INTEGER NOT NULL,
 event_kind TEXT NOT NULL,
 actor_subject_id TEXT,
 actor_role_at_review TEXT,
 dataset_revision_id TEXT,
 representative_of_population_id TEXT,
 representative_ineligible_reasons TEXT NOT NULL,
 details TEXT NOT NULL,
 previous_event_digest TEXT,
 event_digest TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 UNIQUE(project_id,id),
 UNIQUE(batch_id,sequence),
 UNIQUE(batch_id,state_version),
 UNIQUE(batch_id,idempotency_key),
 FOREIGN KEY(project_id,batch_id) REFERENCES governed_review_batches(project_id,id),
 FOREIGN KEY(project_id,actor_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 CHECK(sequence BETWEEN 1 AND 2147483647 AND state_version BETWEEN 1 AND 2147483647 AND expected_previous_state_version BETWEEN 0 AND 2147483647),
 CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 CHECK(actor_role_at_review IS NULL OR (length(actor_role_at_review)>0 AND length(CAST(actor_role_at_review AS BLOB))<=256)),
 CHECK(event_kind IN('open','labeling_closed','alignment_open','adjudicating','resolved','incomplete','frozen','abandoned')),
 CHECK(json_valid(details)),
 CHECK(json_valid(representative_ineligible_reasons) AND json_type(representative_ineligible_reasons)='array'),
 FOREIGN KEY(project_id,dataset_revision_id) REFERENCES dataset_revisions(project_id,id),
 CHECK(length(event_digest)=71 AND substr(event_digest,1,7)='sha256:' AND substr(event_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(previous_event_digest IS NULL OR (length(previous_event_digest)=71 AND substr(previous_event_digest,1,7)='sha256:' AND substr(previous_event_digest,8) NOT GLOB '*[^0-9a-f]*'))
) STRICT;
CREATE TRIGGER governed_review_batch_events_immutable BEFORE UPDATE ON governed_review_batch_events BEGIN SELECT RAISE(ABORT,'immutable governed stream'); END;
CREATE TRIGGER governed_review_batch_events_erase BEFORE DELETE ON governed_review_batch_events WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'governed stream deletion requires project erasure'); END;
CREATE TABLE governed_review_task_events (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL,
 sequence INTEGER NOT NULL,
 state_version INTEGER NOT NULL,
 expected_previous_state_version INTEGER NOT NULL,
 event_kind TEXT NOT NULL,
 actor_subject_id TEXT,
 actor_role_at_review TEXT,
 label_id TEXT,
 canonical_view_bytes BLOB,
 view_digest TEXT,
 view_contract_version TEXT,
 canonicalization_version TEXT,
 exposure_class TEXT,
 activity TEXT,
 reason TEXT,
 previous_event_digest TEXT,
 event_digest TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 request_digest TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 UNIQUE(project_id,id),
 UNIQUE(task_id,sequence),
 UNIQUE(task_id,state_version),
 UNIQUE(task_id,idempotency_key),
 FOREIGN KEY(project_id,task_id) REFERENCES governed_review_tasks(project_id,id),
 FOREIGN KEY(project_id,actor_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 CHECK(sequence BETWEEN 1 AND 2147483647 AND state_version BETWEEN 1 AND 2147483647 AND expected_previous_state_version BETWEEN 0 AND 2147483647),
 CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 CHECK(actor_role_at_review IS NULL OR (length(actor_role_at_review)>0 AND length(CAST(actor_role_at_review AS BLOB))<=256)),
 CHECK(event_kind IN('viewed','deferred','resumed','label_submitted','label_withdrawn','expired')),
 CHECK((event_kind='viewed' AND canonical_view_bytes IS NOT NULL AND length(canonical_view_bytes) BETWEEN 1 AND 2097152 AND view_digest IS NOT NULL AND view_contract_version IS NOT NULL AND canonicalization_version IS NOT NULL AND exposure_class IS NOT NULL AND activity IS NOT NULL AND view_contract_version='rubrist/governed-blind-task-view/v1' AND canonicalization_version='rubrist-canonical-json/v1' AND exposure_class='provenance' AND activity='governed_review') OR (event_kind<>'viewed' AND canonical_view_bytes IS NULL AND view_digest IS NULL AND view_contract_version IS NULL AND canonicalization_version IS NULL AND exposure_class IS NULL AND activity IS NULL)),
 CHECK((event_kind IN('label_submitted','label_withdrawn') AND label_id IS NOT NULL) OR (event_kind NOT IN('label_submitted','label_withdrawn') AND label_id IS NULL)),
 CHECK(event_kind<>'deferred' OR (reason IS NOT NULL AND length(reason)>0)),
 CHECK(reason IS NULL OR length(CAST(reason AS BLOB))<=32768),
 CHECK(view_digest IS NULL OR (length(view_digest)=71 AND substr(view_digest,1,7)='sha256:' AND substr(view_digest,8) NOT GLOB '*[^0-9a-f]*')),
 CHECK(length(event_digest)=71 AND substr(event_digest,1,7)='sha256:' AND substr(event_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(previous_event_digest IS NULL OR (length(previous_event_digest)=71 AND substr(previous_event_digest,1,7)='sha256:' AND substr(previous_event_digest,8) NOT GLOB '*[^0-9a-f]*'))
) STRICT;
CREATE TRIGGER governed_review_task_events_immutable BEFORE UPDATE ON governed_review_task_events BEGIN SELECT RAISE(ABORT,'immutable governed stream'); END;
CREATE TRIGGER governed_review_task_events_erase BEFORE DELETE ON governed_review_task_events WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'governed stream deletion requires project erasure'); END;
CREATE VIEW governed_review_batch_states AS SELECT b.id batch_id,b.project_id,coalesce(e.event_kind,'draft') state,coalesce(e.state_version,0) state_version FROM governed_review_batches b LEFT JOIN governed_review_batch_events e ON e.batch_id=b.id AND e.state_version=(SELECT max(h.state_version) FROM governed_review_batch_events h WHERE h.batch_id=b.id);
CREATE VIEW governed_review_task_states AS SELECT t.id task_id,t.project_id,t.batch_id,t.batch_item_id,coalesce(CASE e.event_kind WHEN 'resumed' THEN 'viewed' WHEN 'label_submitted' THEN 'submitted' WHEN 'label_withdrawn' THEN 'withdrawn' ELSE e.event_kind END,'assigned') state,coalesce(e.state_version,0) state_version FROM governed_review_tasks t LEFT JOIN governed_review_task_events e ON e.task_id=t.id AND e.state_version=(SELECT max(h.state_version) FROM governed_review_task_events h WHERE h.task_id=t.id);
CREATE TRIGGER governed_batch_event_stage BEFORE INSERT ON governed_review_batch_events WHEN NEW.event_kind NOT IN('open','abandoned') BEGIN SELECT RAISE(ABORT,'governed barrier and truth transitions require complete port'); END;
CREATE TRIGGER governed_task_event_stage BEFORE INSERT ON governed_review_task_events WHEN NEW.event_kind NOT IN('viewed','deferred','resumed') BEGIN SELECT RAISE(ABORT,'governed label and expiry transitions require complete port'); END;
CREATE TRIGGER governed_batch_event_insert BEFORE INSERT ON governed_review_batch_events BEGIN
 SELECT CASE WHEN NEW.occurred_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM governed_review_batches b WHERE b.id=NEW.batch_id AND b.project_id=NEW.project_id AND b.created_at<=NEW.occurred_at AND EXISTS(SELECT 1 FROM governed_review_batch_finalizations WHERE batch_id=b.id)) THEN RAISE(ABORT,'batch event requires current owning command and finalized draft') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=s.account_user_id WHERE s.project_id=NEW.project_id AND s.id=NEW.actor_subject_id AND pm.role='owner' AND NEW.actor_role_at_review='owner') THEN RAISE(ABORT,'batch transition requires live owner') END;
 SELECT CASE WHEN NEW.expected_previous_state_version<>(SELECT state_version FROM governed_review_batch_states WHERE batch_id=NEW.batch_id) OR NEW.state_version<>NEW.expected_previous_state_version+1 OR NEW.sequence<>NEW.state_version OR NEW.previous_event_digest IS NOT (SELECT event_digest FROM governed_review_batch_events WHERE batch_id=NEW.batch_id ORDER BY state_version DESC LIMIT 1) THEN RAISE(ABORT,'governed batch state version conflict') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_batch_states WHERE batch_id=NEW.batch_id AND ((state='draft' AND NEW.event_kind IN('open','abandoned')) OR (state='open' AND NEW.event_kind='abandoned'))) THEN RAISE(ABORT,'invalid governed batch transition') END;
 SELECT CASE WHEN NEW.dataset_revision_id IS NOT NULL OR NEW.representative_of_population_id IS NOT NULL OR json_array_length(NEW.representative_ineligible_reasons)<>0 OR governed_jsonb_octets_v1(NEW.details)>65536 THEN RAISE(ABORT,'invalid pre-barrier batch details') END;
 SELECT CASE WHEN NEW.event_digest IS NOT governed_content_v1_digest('governed-review-batch-event/v1',json_object('actorRoleAtReview',NEW.actor_role_at_review,'actorSubjectId',NEW.actor_subject_id,'batchId',NEW.batch_id,'datasetRevisionId',NEW.dataset_revision_id,'details',json(NEW.details),'eventKind',NEW.event_kind,'previousEventDigest',NEW.previous_event_digest,'representativeIneligibleReasons',json(NEW.representative_ineligible_reasons),'representativeOfPopulationId',NEW.representative_of_population_id,'sequence',NEW.sequence,'stateVersion',NEW.state_version)) THEN RAISE(ABORT,'governed stream event digest mismatch') END;
END;
CREATE TRIGGER governed_task_event_insert BEFORE INSERT ON governed_review_task_events BEGIN
 SELECT CASE WHEN NEW.occurred_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM governed_review_tasks t JOIN governed_review_batch_states b ON b.batch_id=t.batch_id WHERE t.id=NEW.task_id AND t.project_id=NEW.project_id AND b.state='open' AND t.created_at<=NEW.occurred_at AND t.reviewer_subject_id IS NEW.actor_subject_id AND t.reviewer_role_at_review IS NEW.actor_role_at_review) THEN RAISE(ABORT,'task action requires open batch and exact reviewer snapshot') END;
 SELECT CASE WHEN NEW.expected_previous_state_version<>(SELECT state_version FROM governed_review_task_states WHERE task_id=NEW.task_id) OR NEW.state_version<>NEW.expected_previous_state_version+1 OR NEW.sequence<>NEW.state_version OR NEW.previous_event_digest IS NOT (SELECT event_digest FROM governed_review_task_events WHERE task_id=NEW.task_id ORDER BY state_version DESC LIMIT 1) THEN RAISE(ABORT,'governed task state version conflict') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_task_states WHERE task_id=NEW.task_id AND ((state='assigned' AND NEW.event_kind='viewed') OR (state='viewed' AND NEW.event_kind='deferred') OR (state='deferred' AND NEW.event_kind='resumed'))) THEN RAISE(ABORT,'invalid governed task transition') END;
 SELECT CASE WHEN NEW.event_kind='viewed' AND (NEW.view_digest IS NOT governed_bytes_v1_digest(NEW.canonical_view_bytes) OR analysis_governed_task_view_valid_v1(NEW.task_id,NEW.project_id,NEW.canonical_view_bytes)<>1) THEN RAISE(ABORT,'blind view bytes must match exact immutable task projection') END;
 SELECT CASE WHEN NEW.event_digest IS NOT governed_content_v1_digest('governed-review-task-event/v1',json_object('activity',NEW.activity,'actorRoleAtReview',NEW.actor_role_at_review,'actorSubjectId',NEW.actor_subject_id,'canonicalizationVersion',NEW.canonicalization_version,'eventKind',NEW.event_kind,'exposureClass',NEW.exposure_class,'labelId',NEW.label_id,'reason',NEW.reason,'canonicalViewBytesBase64',CASE WHEN NEW.canonical_view_bytes IS NULL THEN NULL ELSE governed_base64_v1(NEW.canonical_view_bytes) END,'previousEventDigest',NEW.previous_event_digest,'sequence',NEW.sequence,'stateVersion',NEW.state_version,'taskId',NEW.task_id,'viewContractVersion',NEW.view_contract_version,'viewDigest',NEW.view_digest)) THEN RAISE(ABORT,'governed stream event digest mismatch') END;
END;
