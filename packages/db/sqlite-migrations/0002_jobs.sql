-- Durable delivery state shares the application/auth database. Domain execution
-- fencing remains separate: a queue retry does not authorize another model call.
CREATE TABLE queue_jobs (
  name TEXT NOT NULL CHECK(name IN ('langsmith.import','langfuse.import','ironside.import','judge.run','gate.run','feedback.sync','eval.run','eval.item','binary-calibration.run')),
  id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data)='object'),
  state TEXT NOT NULL DEFAULT 'created' CHECK(state IN ('created','retry','active','completed','cancelled','failed')),
  created_at INTEGER NOT NULL,
  available_at INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0),
  retry_limit INTEGER NOT NULL CHECK(retry_limit>=0 AND retry_count<=retry_limit),
  retry_delay_ms INTEGER NOT NULL CHECK(retry_delay_ms>=0),
  retry_backoff INTEGER NOT NULL CHECK(retry_backoff IN (0,1)),
  expire_ms INTEGER NOT NULL CHECK(expire_ms>0),
  singleton_key TEXT NOT NULL DEFAULT '',
  singleton_slot INTEGER,
  token TEXT,
  lease_until INTEGER,
  finished_at INTEGER,
  error TEXT,
  PRIMARY KEY(name,id),
  CHECK((state='active' AND token IS NOT NULL AND lease_until IS NOT NULL) OR
        (state<>'active' AND token IS NULL AND lease_until IS NULL)),
  CHECK((state IN ('completed','cancelled','failed'))=(finished_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX queue_singleton ON queue_jobs(name,singleton_key,singleton_slot)
  WHERE singleton_slot IS NOT NULL AND state<>'cancelled';
CREATE INDEX queue_available ON queue_jobs(name,available_at,created_at,id) WHERE state IN ('created','retry');
CREATE INDEX queue_expired ON queue_jobs(name,lease_until) WHERE state='active';
CREATE TRIGGER queue_identity_immutable BEFORE UPDATE ON queue_jobs WHEN
  NEW.name<>OLD.name OR NEW.id<>OLD.id OR NEW.data<>OLD.data OR NEW.created_at<>OLD.created_at OR
  NEW.retry_limit<>OLD.retry_limit OR NEW.retry_delay_ms<>OLD.retry_delay_ms OR
  NEW.retry_backoff<>OLD.retry_backoff OR NEW.expire_ms<>OLD.expire_ms OR
  NEW.singleton_key<>OLD.singleton_key OR NEW.singleton_slot IS NOT OLD.singleton_slot
BEGIN SELECT RAISE(ABORT,'immutable queue job identity'); END;
CREATE TRIGGER queue_terminal_immutable BEFORE UPDATE ON queue_jobs
  WHEN OLD.state IN ('completed','cancelled','failed')
BEGIN SELECT RAISE(ABORT,'terminal queue job'); END;
