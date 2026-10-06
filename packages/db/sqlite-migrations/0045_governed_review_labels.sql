-- A label and its submission event form one immutable command bundle.
CREATE TABLE governed_review_labels (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL,
 reviewer_subject_id TEXT NOT NULL,
 attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 2147483647),
 label TEXT NOT NULL CHECK(label IN('pass','fail','cannot_determine')),
 rationale TEXT NOT NULL CHECK(length(rationale)>0 AND length(CAST(rationale AS BLOB))<=32768),
 failure_codes TEXT NOT NULL CHECK(json_valid(failure_codes) AND json_type(failure_codes)='array'),
 blind_view_digest TEXT NOT NULL,
 replaces_label_id TEXT,
 content_digest TEXT NOT NULL,
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)>0 AND length(CAST(idempotency_key AS BLOB))<=1024),
 request_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 created_command_token TEXT NOT NULL,
 UNIQUE(project_id,id), UNIQUE(task_id,attempt), UNIQUE(task_id,idempotency_key), UNIQUE(replaces_label_id),
 UNIQUE(id,project_id,task_id,created_command_token),
 FOREIGN KEY(project_id,task_id) REFERENCES governed_review_tasks(project_id,id),
 FOREIGN KEY(project_id,reviewer_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 FOREIGN KEY(project_id,replaces_label_id) REFERENCES governed_review_labels(project_id,id),
 FOREIGN KEY(id,project_id,task_id,created_command_token) REFERENCES governed_review_label_finalizations(label_id,project_id,task_id,command_token) DEFERRABLE INITIALLY DEFERRED,
 CHECK((attempt=1 AND replaces_label_id IS NULL) OR (attempt>1 AND replaces_label_id IS NOT NULL)),
 CHECK(length(blind_view_digest)=71 AND substr(blind_view_digest,1,7)='sha256:' AND substr(blind_view_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
 CHECK(length(request_digest)=71 AND substr(request_digest,1,7)='sha256:' AND substr(request_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE governed_review_label_finalizations (
 label_id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL,
 command_token TEXT NOT NULL,
 event_id TEXT NOT NULL UNIQUE,
 UNIQUE(label_id,project_id,task_id,command_token),
 FOREIGN KEY(label_id,project_id,task_id,command_token) REFERENCES governed_review_labels(id,project_id,task_id,created_command_token),
 FOREIGN KEY(project_id,event_id) REFERENCES governed_review_task_events(project_id,id)
) STRICT;
CREATE TRIGGER governed_review_labels_immutable BEFORE UPDATE ON governed_review_labels BEGIN SELECT RAISE(ABORT,'immutable governed label evidence'); END;
CREATE TRIGGER governed_review_labels_erase BEFORE DELETE ON governed_review_labels WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'label deletion requires project erasure'); END;
CREATE TRIGGER governed_review_label_finalizations_immutable BEFORE UPDATE ON governed_review_label_finalizations BEGIN SELECT RAISE(ABORT,'immutable governed label evidence'); END;
CREATE TRIGGER governed_review_label_finalizations_erase BEFORE DELETE ON governed_review_label_finalizations WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'label deletion requires project erasure'); END;
CREATE TRIGGER governed_label_insert BEFORE INSERT ON governed_review_labels BEGIN
 SELECT CASE WHEN NEW.created_command_token IS NOT sqlite_command_token() OR NEW.created_at IS NOT sqlite_command_time() THEN RAISE(ABORT,'label requires owning command') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_tasks t JOIN governed_review_batch_states b ON b.batch_id=t.batch_id JOIN governed_review_task_states ts ON ts.task_id=t.id WHERE t.id=NEW.task_id AND t.project_id=NEW.project_id AND t.reviewer_subject_id=NEW.reviewer_subject_id AND b.state='open' AND ts.state IN('viewed','withdrawn')) THEN RAISE(ABORT,'label requires open batch and assigned viewed reviewer') END;
 SELECT CASE WHEN NEW.replaces_label_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM governed_review_labels l JOIN governed_review_task_events e ON e.label_id=l.id WHERE l.id=NEW.replaces_label_id AND l.task_id=NEW.task_id AND l.reviewer_subject_id=NEW.reviewer_subject_id AND l.attempt+1=NEW.attempt AND e.task_id=NEW.task_id AND e.event_kind='label_withdrawn' AND e.state_version=(SELECT max(state_version) FROM governed_review_task_events WHERE task_id=NEW.task_id)) THEN RAISE(ABORT,'replacement must extend latest withdrawn attempt') END;
 SELECT CASE WHEN NEW.blind_view_digest IS NOT (SELECT view_digest FROM governed_review_task_events WHERE task_id=NEW.task_id AND event_kind='viewed' ORDER BY sequence LIMIT 1) THEN RAISE(ABORT,'label must bind exact blind view') END;
 SELECT CASE WHEN json_array_length(NEW.failure_codes)>100 OR EXISTS(SELECT 1 FROM json_each(NEW.failure_codes) WHERE type<>'text' OR length(value)=0 OR length(CAST(value AS BLOB))>1024) OR (SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM json_each(NEW.failure_codes))>65536 THEN RAISE(ABORT,'invalid label failure codes') END;
 SELECT CASE WHEN NEW.content_digest IS NOT governed_content_v1_digest('governed-review-label/v1',json_object('attempt',NEW.attempt,'blindViewDigest',NEW.blind_view_digest,'failureCodes',json(NEW.failure_codes),'label',NEW.label,'rationale',NEW.rationale,'replacesLabelId',NEW.replaces_label_id,'reviewerSubjectId',NEW.reviewer_subject_id,'taskId',NEW.task_id)) THEN RAISE(ABORT,'governed label content digest mismatch') END;
END;
CREATE TRIGGER governed_label_finalize BEFORE INSERT ON governed_review_label_finalizations BEGIN
 SELECT CASE WHEN NEW.command_token IS NOT sqlite_command_token() OR NOT EXISTS(SELECT 1 FROM governed_review_labels l JOIN governed_review_task_events e ON e.label_id=l.id AND e.project_id=l.project_id AND e.task_id=l.task_id WHERE l.id=NEW.label_id AND l.project_id=NEW.project_id AND l.task_id=NEW.task_id AND l.created_command_token=NEW.command_token AND l.created_at=sqlite_command_time() AND e.id=NEW.event_id AND e.event_kind='label_submitted' AND e.actor_subject_id=l.reviewer_subject_id AND e.occurred_at=l.created_at AND e.idempotency_key=l.idempotency_key AND e.request_digest=l.request_digest) THEN RAISE(ABORT,'label requires exact same-command submission event') END;
END;
CREATE TRIGGER governed_task_label_finalize AFTER INSERT ON governed_review_task_events WHEN NEW.event_kind='label_submitted' BEGIN
 INSERT INTO governed_review_label_finalizations(label_id,project_id,task_id,command_token,event_id) VALUES(NEW.label_id,NEW.project_id,NEW.task_id,sqlite_command_token(),NEW.id);
END;
CREATE VIEW governed_active_review_labels AS SELECT t.project_id,t.batch_id,t.batch_item_id,t.id task_id,e.label_id,l.label,l.reviewer_subject_id FROM governed_review_tasks t JOIN governed_review_task_events e ON e.task_id=t.id AND e.state_version=(SELECT max(state_version) FROM governed_review_task_events WHERE task_id=t.id) AND e.event_kind='label_submitted' JOIN governed_review_labels l ON l.id=e.label_id;
DROP TRIGGER governed_task_event_stage;
CREATE TRIGGER governed_task_event_stage BEFORE INSERT ON governed_review_task_events WHEN NEW.event_kind='expired' BEGIN SELECT RAISE(ABORT,'governed expiry requires complete barrier port'); END;
DROP TRIGGER governed_task_event_insert;
CREATE TRIGGER governed_task_event_insert BEFORE INSERT ON governed_review_task_events BEGIN
 SELECT CASE WHEN NEW.occurred_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM governed_review_tasks t JOIN governed_review_batch_states b ON b.batch_id=t.batch_id WHERE t.id=NEW.task_id AND t.project_id=NEW.project_id AND b.state='open' AND t.created_at<=NEW.occurred_at AND t.reviewer_subject_id IS NEW.actor_subject_id AND t.reviewer_role_at_review IS NEW.actor_role_at_review) THEN RAISE(ABORT,'task action requires open batch and exact reviewer snapshot') END;
 SELECT CASE WHEN NEW.expected_previous_state_version<>(SELECT state_version FROM governed_review_task_states WHERE task_id=NEW.task_id) OR NEW.state_version<>NEW.expected_previous_state_version+1 OR NEW.sequence<>NEW.state_version OR NEW.previous_event_digest IS NOT (SELECT event_digest FROM governed_review_task_events WHERE task_id=NEW.task_id ORDER BY state_version DESC LIMIT 1) THEN RAISE(ABORT,'governed task state version conflict') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_review_task_states WHERE task_id=NEW.task_id AND ((state='assigned' AND NEW.event_kind='viewed') OR (state='viewed' AND NEW.event_kind='deferred') OR (state='deferred' AND NEW.event_kind='resumed') OR (state IN('viewed','withdrawn') AND NEW.event_kind='label_submitted') OR (state='submitted' AND NEW.event_kind='label_withdrawn'))) THEN RAISE(ABORT,'invalid governed task transition') END;
 SELECT CASE WHEN NEW.event_kind='viewed' AND (NEW.view_digest IS NOT governed_bytes_v1_digest(NEW.canonical_view_bytes) OR analysis_governed_task_view_valid_v1(NEW.task_id,NEW.project_id,NEW.canonical_view_bytes)<>1) THEN RAISE(ABORT,'blind view bytes must match exact immutable task projection') END;
 SELECT CASE WHEN NEW.event_kind='label_submitted' AND NOT EXISTS(SELECT 1 FROM governed_review_labels l WHERE l.id=NEW.label_id AND l.project_id=NEW.project_id AND l.task_id=NEW.task_id AND l.reviewer_subject_id=NEW.actor_subject_id AND l.created_command_token=sqlite_command_token() AND l.created_at=NEW.occurred_at AND ((SELECT state FROM governed_review_task_states WHERE task_id=NEW.task_id)<>'withdrawn' OR l.replaces_label_id IS (SELECT label_id FROM governed_review_task_events WHERE task_id=NEW.task_id ORDER BY state_version DESC LIMIT 1))) THEN RAISE(ABORT,'submission requires current command label for exact reviewer') END;
 SELECT CASE WHEN NEW.event_kind='label_withdrawn' AND NEW.label_id IS NOT (SELECT label_id FROM governed_active_review_labels WHERE task_id=NEW.task_id) THEN RAISE(ABORT,'withdrawal must name active label') END;
 SELECT CASE WHEN NEW.event_digest IS NOT governed_content_v1_digest('governed-review-task-event/v1',json_object('activity',NEW.activity,'actorRoleAtReview',NEW.actor_role_at_review,'actorSubjectId',NEW.actor_subject_id,'canonicalizationVersion',NEW.canonicalization_version,'eventKind',NEW.event_kind,'exposureClass',NEW.exposure_class,'labelId',NEW.label_id,'reason',NEW.reason,'canonicalViewBytesBase64',CASE WHEN NEW.canonical_view_bytes IS NULL THEN NULL ELSE governed_base64_v1(NEW.canonical_view_bytes) END,'previousEventDigest',NEW.previous_event_digest,'sequence',NEW.sequence,'stateVersion',NEW.state_version,'taskId',NEW.task_id,'viewContractVersion',NEW.view_contract_version,'viewDigest',NEW.view_digest)) THEN RAISE(ABORT,'governed stream event digest mismatch') END;
END;
