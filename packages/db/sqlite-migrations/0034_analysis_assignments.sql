CREATE TABLE analysis_observation_assignment_events (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,study_id TEXT NOT NULL,study_item_id TEXT NOT NULL,observation_event_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),predecessor_event_id TEXT,predecessor_event_digest TEXT,event_type TEXT NOT NULL CHECK(event_type IN('assigned','withdrawn')),
 taxonomy_id TEXT NOT NULL,taxonomy_revision_id TEXT NOT NULL,taxonomy_revision_sequence INTEGER NOT NULL CHECK(taxonomy_revision_sequence BETWEEN 1 AND 10000),
 code_id TEXT,rationale TEXT NOT NULL,actor_subject_id TEXT NOT NULL,actor_user_id TEXT NOT NULL,actor_role TEXT NOT NULL CHECK(actor_role IN('owner','member')),
 idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,event_digest TEXT NOT NULL,occurred_at TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(observation_event_id,version),UNIQUE(observation_event_id,idempotency_key),
 CHECK((predecessor_event_id IS NULL)=(predecessor_event_digest IS NULL)),CHECK((event_type='withdrawn')=(code_id IS NULL)),
 FOREIGN KEY(project_id,study_id) REFERENCES analysis_studies(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,study_item_id) REFERENCES analysis_study_items(project_id,id),
 FOREIGN KEY(project_id,observation_event_id) REFERENCES analysis_study_item_events(project_id,id),
 FOREIGN KEY(project_id,predecessor_event_id) REFERENCES analysis_observation_assignment_events(project_id,id),
 FOREIGN KEY(project_id,taxonomy_id) REFERENCES analysis_failure_taxonomies(project_id,id),
 FOREIGN KEY(project_id,taxonomy_revision_id) REFERENCES analysis_failure_taxonomy_revisions(project_id,id),
 FOREIGN KEY(project_id,code_id) REFERENCES analysis_failure_codes(project_id,id),
 FOREIGN KEY(project_id,actor_subject_id) REFERENCES governed_reviewer_subjects(project_id,id)
) STRICT;
CREATE INDEX analysis_assignment_study ON analysis_observation_assignment_events(study_id,study_item_id,observation_event_id,version);
CREATE TRIGGER analysis_assignment_insert BEFORE INSERT ON analysis_observation_assignment_events BEGIN
 SELECT CASE WHEN NEW.occurred_at IS NOT sqlite_command_time() THEN RAISE(ABORT,'assignment requires command time') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members m ON m.project_id=s.project_id AND m.user_id=s.account_user_id WHERE s.project_id=NEW.project_id AND s.id=NEW.actor_subject_id AND s.account_user_id=NEW.actor_user_id AND m.role=NEW.actor_role) THEN RAISE(ABORT,'assignment requires exact actor role') END;
 SELECT CASE WHEN (SELECT to_state FROM analysis_study_events WHERE study_id=NEW.study_id ORDER BY version DESC LIMIT 1) IS NOT 'coding_open'
 OR EXISTS(SELECT 1 FROM analysis_study_events WHERE study_id=NEW.study_id AND event_type='coding_opened' AND stopping_rule='server_deadline' AND close_at<=sqlite_command_time()) THEN RAISE(ABORT,'assignment coding closed by state or deadline') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_study_item_active_events WHERE id=NEW.observation_event_id AND project_id=NEW.project_id AND study_id=NEW.study_id AND study_item_id=NEW.study_item_id AND event_type='failure_observed') THEN RAISE(ABORT,'assignment requires exact active failure observation') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revisions r JOIN analysis_taxonomy_finalizations f ON f.revision_id=r.id
 WHERE r.id=NEW.taxonomy_revision_id AND r.project_id=NEW.project_id AND r.taxonomy_id=NEW.taxonomy_id AND r.sequence=NEW.taxonomy_revision_sequence AND NOT EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revisions WHERE predecessor_revision_id=r.id)) THEN RAISE(ABORT,'assignment requires finalized current taxonomy head') END;
 SELECT CASE WHEN NEW.version IS NOT coalesce((SELECT max(version) FROM analysis_observation_assignment_events WHERE observation_event_id=NEW.observation_event_id),0)+1
 OR NEW.predecessor_event_id IS NOT (SELECT id FROM analysis_observation_assignment_events WHERE observation_event_id=NEW.observation_event_id ORDER BY version DESC LIMIT 1)
 OR NEW.predecessor_event_digest IS NOT (SELECT event_digest FROM analysis_observation_assignment_events WHERE observation_event_id=NEW.observation_event_id ORDER BY version DESC LIMIT 1)
 OR (NEW.version=1 AND NEW.event_type<>'assigned') OR EXISTS(SELECT 1 FROM analysis_observation_assignment_events WHERE observation_event_id=NEW.observation_event_id AND (taxonomy_id<>NEW.taxonomy_id OR taxonomy_revision_sequence>NEW.taxonomy_revision_sequence)) THEN RAISE(ABORT,'assignment compare-and-swap ancestry mismatch') END;
 SELECT CASE WHEN NEW.event_type='assigned' AND NOT EXISTS(SELECT 1 FROM analysis_failure_taxonomy_revision_codes WHERE taxonomy_revision_id=NEW.taxonomy_revision_id AND taxonomy_id=NEW.taxonomy_id AND code_id=NEW.code_id AND status='active') THEN RAISE(ABORT,'assignment code must be active in exact revision') END;
 SELECT CASE WHEN analysis_trimmed_text_v1(NEW.rationale,5000) IS NOT 1 OR analysis_trimmed_text_v1(NEW.idempotency_key,240) IS NOT 1 THEN RAISE(ABORT,'assignment invalid text') END;
 SELECT CASE WHEN NEW.request_digest IS NOT analysis_sha256_v1(json_object('basis','analysis-observation-assignment-request/v1','codeId',NEW.code_id,'eventType',NEW.event_type,'expectedPredecessorEventDigest',NEW.predecessor_event_digest,'expectedPredecessorEventId',NEW.predecessor_event_id,'expectedVersion',CAST(NEW.version-1 AS TEXT),'observationEventId',NEW.observation_event_id,'rationale',NEW.rationale,'taxonomyRevisionId',NEW.taxonomy_revision_id)) THEN RAISE(ABORT,'assignment request digest mismatch') END;
 SELECT CASE WHEN NEW.event_digest IS NOT analysis_sha256_v1(json_object('basis','analysis-observation-assignment/v1','id',NEW.id,'projectId',NEW.project_id,'studyId',NEW.study_id,'studyItemId',NEW.study_item_id,'observationEventId',NEW.observation_event_id,'version',CAST(NEW.version AS TEXT),
 'predecessorEventId',NEW.predecessor_event_id,'predecessorEventDigest',NEW.predecessor_event_digest,'eventType',NEW.event_type,'taxonomyId',NEW.taxonomy_id,'taxonomyRevisionId',NEW.taxonomy_revision_id,'taxonomyRevisionSequence',NEW.taxonomy_revision_sequence,
 'codeId',NEW.code_id,'rationale',NEW.rationale,'actorSubjectId',NEW.actor_subject_id,'actorUserId',NEW.actor_user_id,'actorRole',NEW.actor_role,'idempotencyKey',NEW.idempotency_key,'requestDigest',NEW.request_digest,'occurredAt',NEW.occurred_at)) THEN RAISE(ABORT,'assignment event digest mismatch') END;
END;
CREATE TRIGGER analysis_assignments_immutable BEFORE UPDATE ON analysis_observation_assignment_events BEGIN SELECT RAISE(ABORT,'immutable observation assignment'); END;
CREATE TRIGGER analysis_assignments_erase BEFORE DELETE ON analysis_observation_assignment_events WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'assignment deletion requires project erasure'); END;
