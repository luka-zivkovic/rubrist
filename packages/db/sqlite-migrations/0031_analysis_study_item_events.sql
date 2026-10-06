CREATE TABLE analysis_study_item_events (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,study_id TEXT NOT NULL,study_item_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),predecessor_event_id TEXT,predecessor_event_digest TEXT,
 event_type TEXT NOT NULL CHECK(event_type IN('failure_observed','failure_withdrawn','no_failure_observed','no_failure_withdrawn','coding_completed','coding_reopened')),
 target_event_id TEXT,target_event_digest TEXT,failure_label TEXT,rationale TEXT,
 anchor_kind TEXT CHECK(anchor_kind IN('case_output','step')),anchor_step_index INTEGER CHECK(anchor_step_index BETWEEN 0 AND 49),
 actor_subject_id TEXT NOT NULL,actor_user_id TEXT NOT NULL,actor_role TEXT NOT NULL CHECK(actor_role IN('owner','member')),
 idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,event_digest TEXT NOT NULL,occurred_at TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(study_item_id,version),UNIQUE(study_item_id,idempotency_key),
 FOREIGN KEY(project_id,study_id) REFERENCES analysis_studies(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,study_item_id) REFERENCES analysis_study_items(project_id,id),
 FOREIGN KEY(project_id,predecessor_event_id) REFERENCES analysis_study_item_events(project_id,id),
 FOREIGN KEY(project_id,target_event_id) REFERENCES analysis_study_item_events(project_id,id),
 FOREIGN KEY(project_id,actor_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 CHECK((predecessor_event_id IS NULL)=(predecessor_event_digest IS NULL)),
 CHECK((target_event_id IS NULL)=(target_event_digest IS NULL)),
 CHECK((event_type='failure_observed' AND target_event_id IS NULL AND failure_label IS NOT NULL AND rationale IS NOT NULL AND anchor_kind IS NOT NULL
 AND ((anchor_kind='case_output' AND anchor_step_index IS NULL) OR (anchor_kind='step' AND anchor_step_index IS NOT NULL)))
 OR (event_type IN('failure_withdrawn','no_failure_withdrawn','coding_reopened') AND target_event_id IS NOT NULL AND failure_label IS NULL AND rationale IS NOT NULL AND anchor_kind IS NULL AND anchor_step_index IS NULL)
 OR (event_type='no_failure_observed' AND target_event_id IS NULL AND failure_label IS NULL AND rationale IS NOT NULL AND anchor_kind IS NULL AND anchor_step_index IS NULL)
 OR (event_type='coding_completed' AND target_event_id IS NULL AND failure_label IS NULL AND rationale IS NULL AND anchor_kind IS NULL AND anchor_step_index IS NULL))
) STRICT;
CREATE INDEX analysis_study_item_event_target ON analysis_study_item_events(target_event_id,event_type);
CREATE INDEX analysis_study_item_event_study ON analysis_study_item_events(study_id,study_item_id,version);
CREATE VIEW analysis_study_item_active_events AS SELECT e.* FROM analysis_study_item_events e
 WHERE e.event_type IN('failure_observed','no_failure_observed','coding_completed') AND NOT EXISTS(
 SELECT 1 FROM analysis_study_item_events withdrawal WHERE withdrawal.target_event_id=e.id AND withdrawal.study_item_id=e.study_item_id
 AND withdrawal.event_type=CASE e.event_type WHEN 'failure_observed' THEN 'failure_withdrawn' WHEN 'no_failure_observed' THEN 'no_failure_withdrawn' ELSE 'coding_reopened' END);
CREATE TRIGGER analysis_study_item_event_insert BEFORE INSERT ON analysis_study_item_events BEGIN
 SELECT CASE WHEN NEW.occurred_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM analysis_study_items WHERE id=NEW.study_item_id AND study_id=NEW.study_id AND project_id=NEW.project_id)
 THEN RAISE(ABORT,'study item event requires exact item and command time') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members m ON m.project_id=s.project_id AND m.user_id=s.account_user_id
 WHERE s.project_id=NEW.project_id AND s.id=NEW.actor_subject_id AND s.account_user_id=NEW.actor_user_id AND m.role=NEW.actor_role) THEN RAISE(ABORT,'study item event requires exact actor role') END;
 SELECT CASE WHEN (SELECT to_state FROM analysis_study_events WHERE study_id=NEW.study_id ORDER BY version DESC LIMIT 1) IS NOT 'coding_open'
 OR EXISTS(SELECT 1 FROM analysis_study_events WHERE study_id=NEW.study_id AND event_type='coding_opened' AND stopping_rule='server_deadline' AND close_at<=sqlite_command_time())
 THEN RAISE(ABORT,'study item coding closed by state or deadline') END;
 SELECT CASE WHEN NEW.version IS NOT coalesce((SELECT max(version) FROM analysis_study_item_events WHERE study_item_id=NEW.study_item_id),0)+1
 OR NEW.predecessor_event_id IS NOT (SELECT id FROM analysis_study_item_events WHERE study_item_id=NEW.study_item_id ORDER BY version DESC LIMIT 1)
 OR NEW.predecessor_event_digest IS NOT (SELECT event_digest FROM analysis_study_item_events WHERE study_item_id=NEW.study_item_id ORDER BY version DESC LIMIT 1)
 THEN RAISE(ABORT,'study item event compare-and-swap head mismatch') END;
 SELECT CASE WHEN analysis_trimmed_text_v1(NEW.idempotency_key,240) IS NOT 1 OR (NEW.failure_label IS NOT NULL AND analysis_trimmed_text_v1(NEW.failure_label,500) IS NOT 1)
 OR (NEW.rationale IS NOT NULL AND analysis_trimmed_text_v1(NEW.rationale,5000) IS NOT 1) THEN RAISE(ABORT,'study item event invalid text') END;
 SELECT CASE WHEN NEW.event_type<>'coding_reopened' AND EXISTS(SELECT 1 FROM analysis_study_item_active_events WHERE study_item_id=NEW.study_item_id AND event_type='coding_completed') THEN RAISE(ABORT,'completed coding must be reopened') END;
 SELECT CASE WHEN NEW.target_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM analysis_study_item_active_events WHERE id=NEW.target_event_id AND event_digest=NEW.target_event_digest AND study_item_id=NEW.study_item_id
 AND event_type=CASE NEW.event_type WHEN 'failure_withdrawn' THEN 'failure_observed' WHEN 'no_failure_withdrawn' THEN 'no_failure_observed' WHEN 'coding_reopened' THEN 'coding_completed' END) THEN RAISE(ABORT,'study item event requires exact active target') END;
 SELECT CASE WHEN NEW.event_type='failure_observed' AND EXISTS(SELECT 1 FROM analysis_study_item_active_events WHERE study_item_id=NEW.study_item_id AND event_type='no_failure_observed') THEN RAISE(ABORT,'failure conflicts with active no-failure evidence') END;
 SELECT CASE WHEN NEW.event_type='no_failure_observed' AND EXISTS(SELECT 1 FROM analysis_study_item_active_events WHERE study_item_id=NEW.study_item_id AND event_type IN('failure_observed','no_failure_observed')) THEN RAISE(ABORT,'no-failure conflicts with active evidence') END;
 SELECT CASE WHEN NEW.event_type='coding_completed' AND NOT EXISTS(SELECT 1 FROM analysis_study_item_active_events WHERE study_item_id=NEW.study_item_id AND event_type IN('failure_observed','no_failure_observed')) THEN RAISE(ABORT,'coding completion requires active evidence') END;
 SELECT CASE WHEN NEW.event_type='failure_observed' AND NOT EXISTS(SELECT 1 FROM analysis_study_items s JOIN dataset_revision_items r ON r.id=s.revision_item_id AND r.project_id=s.project_id
 WHERE s.id=NEW.study_item_id AND ((NEW.anchor_kind='case_output' AND json_type(r.payload_snapshot,'$.output') IS NOT NULL)
 OR (NEW.anchor_kind='step' AND json_type(r.payload_snapshot,'$.steps')='array' AND NEW.anchor_step_index<json_array_length(r.payload_snapshot,'$.steps')))) THEN RAISE(ABORT,'failure anchor must exist in frozen payload') END;
 SELECT CASE WHEN NEW.request_digest IS NOT analysis_sha256_v1(json_patch(json_object('basis','analysis-study-item-event-request/v1','eventType',NEW.event_type,'expectedVersion',CAST(NEW.version-1 AS TEXT),'projectId',NEW.project_id,'studyId',NEW.study_id,'studyItemId',NEW.study_item_id),CASE NEW.event_type
 WHEN 'failure_observed' THEN json_object('evidenceAnchor',CASE NEW.anchor_kind WHEN 'case_output' THEN json_object('kind','case_output') ELSE json_object('kind','step','stepIndex',NEW.anchor_step_index) END,'failureLabel',NEW.failure_label,'rationale',NEW.rationale)
 WHEN 'no_failure_observed' THEN json_object('rationale',NEW.rationale)
 WHEN 'coding_completed' THEN '{}'
 ELSE json_object('rationale',NEW.rationale,'targetEventId',NEW.target_event_id,'targetEventDigest',NEW.target_event_digest) END)) THEN RAISE(ABORT,'study item request_digest mismatch') END;
 SELECT CASE WHEN NEW.event_digest IS NOT analysis_sha256_v1(json_patch(json_object('basis','analysis-study-item-event/v1','eventType',NEW.event_type,'id',NEW.id,'projectId',NEW.project_id,'studyId',NEW.study_id,'studyItemId',NEW.study_item_id,'version',CAST(NEW.version AS TEXT),
 'predecessorEventId',NEW.predecessor_event_id,'predecessorEventDigest',NEW.predecessor_event_digest,'actorRole',NEW.actor_role,'actorSubjectId',NEW.actor_subject_id,'actorUserId',NEW.actor_user_id,'idempotencyKey',NEW.idempotency_key,'requestDigest',NEW.request_digest,'occurredAt',NEW.occurred_at),CASE NEW.event_type
 WHEN 'failure_observed' THEN json_object('evidenceAnchor',CASE NEW.anchor_kind WHEN 'case_output' THEN json_object('kind','case_output') ELSE json_object('kind','step','stepIndex',NEW.anchor_step_index) END,'failureLabel',NEW.failure_label,'rationale',NEW.rationale)
 WHEN 'no_failure_observed' THEN json_object('rationale',NEW.rationale)
 WHEN 'coding_completed' THEN '{}'
 ELSE json_object('rationale',NEW.rationale,'targetEventId',NEW.target_event_id,'targetEventDigest',NEW.target_event_digest) END)) THEN RAISE(ABORT,'study item event_digest mismatch') END;
END;
CREATE TRIGGER analysis_study_item_events_immutable BEFORE UPDATE ON analysis_study_item_events BEGIN SELECT RAISE(ABORT,'immutable study item events'); END;
CREATE TRIGGER analysis_study_item_events_erase BEFORE DELETE ON analysis_study_item_events WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'study item events deletion requires project erasure'); END;
