CREATE TABLE analysis_study_deadline_retry_state (
 study_id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL,
 failure_count INTEGER NOT NULL CHECK(failure_count BETWEEN 1 AND 1000000),last_error_code TEXT NOT NULL CHECK(last_error_code='closure_failed'),
 last_failed_at TEXT NOT NULL,next_retry_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 CHECK(updated_at=last_failed_at),CHECK(next_retry_at>last_failed_at),
 UNIQUE(project_id,study_id),FOREIGN KEY(project_id,study_id) REFERENCES analysis_studies(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX analysis_study_deadline_retry_due ON analysis_study_deadline_retry_state(project_id,next_retry_at,study_id);
CREATE TRIGGER analysis_deadline_retry_insert BEFORE INSERT ON analysis_study_deadline_retry_state BEGIN
 SELECT CASE WHEN NEW.last_failed_at IS NOT sqlite_command_time() OR NOT EXISTS(SELECT 1 FROM analysis_study_events e WHERE e.project_id=NEW.project_id AND e.study_id=NEW.study_id AND e.event_type='coding_opened' AND e.stopping_rule='server_deadline' AND e.close_at<=sqlite_command_time()
 AND (SELECT to_state FROM analysis_study_events WHERE study_id=e.study_id ORDER BY version DESC LIMIT 1)='coding_open') THEN RAISE(ABORT,'deadline retry requires exact overdue open study and command time') END;
 SELECT CASE WHEN NEW.failure_count IS NOT min(coalesce((SELECT failure_count FROM analysis_study_deadline_retry_state WHERE study_id=NEW.study_id),0),999999)+1
 OR NEW.next_retry_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.last_failed_at,'+'||min(3600,5*(1 << min(NEW.failure_count-1,10)))||' seconds') THEN RAISE(ABORT,'deadline retry requires exact bounded backoff') END;
END;
CREATE TRIGGER analysis_deadline_retry_update BEFORE UPDATE ON analysis_study_deadline_retry_state BEGIN
 SELECT CASE WHEN NEW.study_id<>OLD.study_id OR NEW.project_id<>OLD.project_id OR NEW.failure_count IS NOT min(OLD.failure_count,999999)+1 OR NEW.last_failed_at IS NOT sqlite_command_time()
 OR NEW.next_retry_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.last_failed_at,'+'||min(3600,5*(1 << min(NEW.failure_count-1,10)))||' seconds')
 OR NOT EXISTS(SELECT 1 FROM analysis_study_events e WHERE e.project_id=NEW.project_id AND e.study_id=NEW.study_id AND e.event_type='coding_opened' AND e.stopping_rule='server_deadline' AND e.close_at<=sqlite_command_time()
 AND (SELECT to_state FROM analysis_study_events WHERE study_id=e.study_id ORDER BY version DESC LIMIT 1)='coding_open') THEN RAISE(ABORT,'deadline retry update requires exact overdue study and bounded backoff') END;
END;
