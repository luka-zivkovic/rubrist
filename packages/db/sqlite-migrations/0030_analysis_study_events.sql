-- Append-only CAS transitions. Closure transitions remain gated until their
-- complete evidence bundle is installed by the following study migrations.
CREATE TABLE analysis_study_events (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,study_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0),predecessor_event_id TEXT,predecessor_event_digest TEXT,
 event_type TEXT NOT NULL CHECK(event_type IN('coding_opened','coding_closed','study_completed','study_abandoned')),
 from_state TEXT NOT NULL CHECK(from_state IN('draft','coding_open','coding_closed')),
 to_state TEXT NOT NULL CHECK(to_state IN('coding_open','coding_closed','completed','abandoned')),
 stopping_rule TEXT CHECK(stopping_rule IN('server_deadline','explicit_owner_close')),close_at TEXT,
 close_cause TEXT CHECK(close_cause IN('server_deadline','explicit_owner_close')),
 closure_id TEXT,closure_digest TEXT,expected_closure_digest TEXT,reason TEXT,
 actor_subject_id TEXT,actor_user_id TEXT,actor_role TEXT NOT NULL CHECK(actor_role IN('owner','system')),
 idempotency_key TEXT NOT NULL,request_digest TEXT NOT NULL,event_digest TEXT NOT NULL,occurred_at TEXT NOT NULL,
 UNIQUE(project_id,id),UNIQUE(study_id,version),UNIQUE(study_id,idempotency_key),
 FOREIGN KEY(project_id,study_id) REFERENCES analysis_studies(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,predecessor_event_id) REFERENCES analysis_study_events(project_id,id),
 FOREIGN KEY(project_id,actor_subject_id) REFERENCES governed_reviewer_subjects(project_id,id),
 CHECK((predecessor_event_id IS NULL)=(predecessor_event_digest IS NULL)),
 CHECK((actor_subject_id IS NULL)=(actor_user_id IS NULL)),
 CHECK((actor_role='system')=(actor_subject_id IS NULL)),
 CHECK((event_type='coding_opened' AND stopping_rule IS NOT NULL AND close_cause IS NULL AND closure_id IS NULL AND closure_digest IS NULL AND expected_closure_digest IS NULL AND reason IS NULL
   AND ((stopping_rule='server_deadline' AND close_at IS NOT NULL) OR (stopping_rule='explicit_owner_close' AND close_at IS NULL)))
 OR (event_type='coding_closed' AND stopping_rule IS NULL AND close_at IS NULL AND close_cause IS NOT NULL AND closure_id IS NOT NULL AND closure_digest IS NOT NULL AND expected_closure_digest IS NULL)
 OR (event_type='study_completed' AND stopping_rule IS NULL AND close_at IS NULL AND close_cause IS NULL AND closure_id IS NULL AND closure_digest IS NULL AND expected_closure_digest IS NOT NULL AND reason IS NULL)
 OR (event_type='study_abandoned' AND stopping_rule IS NULL AND close_at IS NULL AND close_cause IS NULL AND closure_id IS NULL AND closure_digest IS NULL AND expected_closure_digest IS NULL AND reason IS NOT NULL))
) STRICT;
CREATE INDEX analysis_study_deadline ON analysis_study_events(close_at,study_id) WHERE event_type='coding_opened' AND stopping_rule='server_deadline';
CREATE TRIGGER analysis_study_closure_transition_staged BEFORE INSERT ON analysis_study_events
 WHEN NEW.event_type IN('coding_closed','study_completed') BEGIN SELECT RAISE(ABORT,'study closure evidence not installed'); END;
CREATE TRIGGER analysis_study_event_insert BEFORE INSERT ON analysis_study_events BEGIN
 SELECT CASE WHEN NEW.occurred_at IS NOT sqlite_command_time() THEN RAISE(ABORT,'study event requires command time') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM analysis_study_finalizations WHERE project_id=NEW.project_id AND study_id=NEW.study_id) THEN RAISE(ABORT,'study event requires finalized study') END;
 SELECT CASE WHEN NEW.version IS NOT coalesce((SELECT max(version) FROM analysis_study_events WHERE study_id=NEW.study_id),0)+1
 OR NEW.predecessor_event_id IS NOT (SELECT id FROM analysis_study_events WHERE study_id=NEW.study_id ORDER BY version DESC LIMIT 1)
 OR NEW.predecessor_event_digest IS NOT (SELECT event_digest FROM analysis_study_events WHERE study_id=NEW.study_id ORDER BY version DESC LIMIT 1)
 OR NEW.from_state IS NOT coalesce((SELECT to_state FROM analysis_study_events WHERE study_id=NEW.study_id ORDER BY version DESC LIMIT 1),'draft')
 THEN RAISE(ABORT,'study event compare-and-swap head mismatch') END;
 SELECT CASE WHEN analysis_trimmed_text_v1(NEW.idempotency_key,240) IS NOT 1
 OR (NEW.reason IS NOT NULL AND analysis_trimmed_text_v1(NEW.reason,2000) IS NOT 1) THEN RAISE(ABORT,'study event invalid text') END;
 SELECT CASE WHEN NEW.actor_role='owner' AND NOT EXISTS(SELECT 1 FROM governed_reviewer_subjects s JOIN project_members m ON m.project_id=s.project_id AND m.user_id=s.account_user_id
 WHERE s.project_id=NEW.project_id AND s.id=NEW.actor_subject_id AND s.account_user_id=NEW.actor_user_id AND m.role='owner') THEN RAISE(ABORT,'study event requires exact owner subject') END;
 SELECT CASE WHEN NEW.event_type='coding_opened' AND (NEW.from_state<>'draft' OR NEW.to_state<>'coding_open' OR NEW.actor_role<>'owner'
 OR (NEW.stopping_rule='server_deadline' AND (NEW.close_at IS NOT analysis_timestamp_v1(NEW.close_at) OR NEW.close_at<=sqlite_command_time()))) THEN RAISE(ABORT,'study open requires draft and future normalized deadline') END;
 SELECT CASE WHEN NEW.event_type='study_abandoned' AND (NEW.from_state NOT IN('draft','coding_open') OR NEW.to_state<>'abandoned' OR NEW.actor_role<>'owner'
 OR EXISTS(SELECT 1 FROM analysis_study_events WHERE study_id=NEW.study_id AND event_type='coding_opened' AND stopping_rule='server_deadline' AND close_at<=sqlite_command_time())) THEN RAISE(ABORT,'study abandon requires draft or open before deadline') END;
 SELECT CASE WHEN NEW.request_digest IS NOT analysis_sha256_v1(CASE NEW.event_type
 WHEN 'coding_opened' THEN json_set(json_object('basis','analysis-study-event-request/v1','eventType',NEW.event_type,'expectedVersion',CAST(NEW.version-1 AS TEXT),'studyId',NEW.study_id),'$.stoppingRule',json_object('closeAt',NEW.close_at,'kind',NEW.stopping_rule))
 WHEN 'study_completed' THEN json_set(json_object('basis','analysis-study-event-request/v1','eventType',NEW.event_type,'expectedVersion',CAST(NEW.version-1 AS TEXT),'studyId',NEW.study_id),'$.expectedClosureDigest',NEW.expected_closure_digest)
 ELSE json_set(json_object('basis','analysis-study-event-request/v1','eventType',NEW.event_type,'expectedVersion',CAST(NEW.version-1 AS TEXT),'studyId',NEW.study_id),'$.reason',NEW.reason) END) THEN RAISE(ABORT,'study event request digest mismatch') END;
 SELECT CASE WHEN NEW.event_digest IS NOT analysis_sha256_v1(json_object(
 'basis','analysis-study-event/v1','id',NEW.id,'projectId',NEW.project_id,'studyId',NEW.study_id,'version',CAST(NEW.version AS TEXT),
 'predecessorEventId',NEW.predecessor_event_id,'predecessorEventDigest',NEW.predecessor_event_digest,'eventType',NEW.event_type,'fromState',NEW.from_state,'toState',NEW.to_state,
 'stoppingRule',CASE WHEN NEW.event_type='coding_opened' THEN json_object('kind',NEW.stopping_rule,'closeAt',NEW.close_at) ELSE NULL END,
 'closeCause',NEW.close_cause,'closureId',NEW.closure_id,'closureDigest',NEW.closure_digest,'expectedClosureDigest',NEW.expected_closure_digest,'reason',NEW.reason,
 'actorSubjectId',NEW.actor_subject_id,'actorUserId',NEW.actor_user_id,'actorRole',NEW.actor_role,'idempotencyKey',NEW.idempotency_key,'requestDigest',NEW.request_digest,'occurredAt',NEW.occurred_at)) THEN RAISE(ABORT,'study event digest mismatch') END;
END;
CREATE TRIGGER analysis_study_events_immutable BEFORE UPDATE ON analysis_study_events BEGIN SELECT RAISE(ABORT,'immutable study events'); END;
CREATE TRIGGER analysis_study_events_erase BEFORE DELETE ON analysis_study_events WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id) BEGIN SELECT RAISE(ABORT,'study events deletion requires project erasure'); END;
