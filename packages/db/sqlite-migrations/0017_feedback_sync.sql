CREATE TABLE feedback_sync_jobs (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 judge_run_id TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider IN ('langsmith','langfuse','ironside')),
 status TEXT NOT NULL CHECK(status IN ('pending','synced','failed','blocked')),attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),last_error TEXT,created_at TEXT NOT NULL,
 FOREIGN KEY(project_id,judge_run_id) REFERENCES judge_runs(project_id,id) ON DELETE CASCADE,UNIQUE(judge_run_id,provider)
) STRICT;
CREATE INDEX feedback_project_status ON feedback_sync_jobs(project_id,status,created_at,id);
CREATE TRIGGER feedback_binding BEFORE INSERT ON feedback_sync_jobs WHEN NOT EXISTS(
 SELECT 1 FROM judge_runs j JOIN cases c ON c.id=j.case_id AND c.project_id=j.project_id
 JOIN raw_traces r ON r.id=c.raw_trace_id AND r.project_id=c.project_id JOIN integrations i ON i.id=r.source_integration_id AND i.project_id=r.project_id AND i.provider=r.source
 WHERE j.id=NEW.judge_run_id AND j.project_id=NEW.project_id AND i.provider=NEW.provider)
BEGIN SELECT RAISE(ABORT,'feedback integration binding mismatch'); END;
CREATE TRIGGER feedback_identity BEFORE UPDATE ON feedback_sync_jobs WHEN NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.judge_run_id<>OLD.judge_run_id OR NEW.provider<>OLD.provider OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable feedback identity'); END;
CREATE TRIGGER feedback_synced_terminal BEFORE UPDATE ON feedback_sync_jobs WHEN OLD.status='synced' AND(NEW.status<>'synced' OR NEW.attempts<>OLD.attempts OR NEW.last_error IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'synced feedback is terminal'); END;
