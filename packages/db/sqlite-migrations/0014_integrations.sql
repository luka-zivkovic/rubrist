CREATE TABLE integrations (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK(provider IN ('langsmith','langfuse','ironside')),encrypted_credentials TEXT NOT NULL,
 config TEXT NOT NULL CHECK(json_valid(config) AND json_type(config)='object'),created_at TEXT NOT NULL,
 poll_enabled INTEGER NOT NULL DEFAULT 1 CHECK(poll_enabled IN (0,1)),poll_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK(poll_interval_seconds>0),
 poll_limit INTEGER NOT NULL DEFAULT 25 CHECK(poll_limit>0),last_polled_at TEXT,last_tested_at TEXT,
 last_test_result TEXT CHECK(last_test_result IS NULL OR json_valid(last_test_result)),UNIQUE(project_id,provider),UNIQUE(project_id,id,provider)
) STRICT;
CREATE INDEX integrations_poll ON integrations(provider,poll_enabled,last_polled_at);
CREATE TABLE import_jobs (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),started_at TEXT,completed_at TEXT,error TEXT,
 source TEXT NOT NULL CHECK(source IN ('manual','langsmith','langfuse','ironside')),source_integration_id TEXT REFERENCES integrations(id) ON DELETE SET NULL,
 queue_job_id TEXT,requested_limit INTEGER,imported_count INTEGER NOT NULL DEFAULT 0 CHECK(imported_count>=0),queued_judge_count INTEGER NOT NULL DEFAULT 0 CHECK(queued_judge_count>=0),
 actor_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,created_at TEXT NOT NULL,skill_version_id TEXT,
 UNIQUE(project_id,id),FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id),
 CHECK(skill_version_id IS NOT NULL OR status='failed')
) STRICT;
CREATE INDEX import_jobs_project_time ON import_jobs(project_id,created_at DESC,id DESC);
CREATE TRIGGER import_job_binding BEFORE INSERT ON import_jobs WHEN NEW.source_integration_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM integrations WHERE project_id=NEW.project_id AND id=NEW.source_integration_id AND provider=NEW.source)
BEGIN SELECT RAISE(ABORT,'import integration binding mismatch'); END;
CREATE TRIGGER import_job_identity BEFORE UPDATE ON import_jobs WHEN NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.source<>OLD.source OR
 (NEW.source_integration_id IS NOT OLD.source_integration_id AND (NEW.source_integration_id IS NOT NULL OR EXISTS(SELECT 1 FROM integrations WHERE id=OLD.source_integration_id))) OR NEW.skill_version_id IS NOT OLD.skill_version_id OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable import job identity'); END;
