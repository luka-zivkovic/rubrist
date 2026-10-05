-- Synthetic schema: demonstrates mechanisms, not a port of application tables.
CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL) STRICT;
CREATE TABLE bundles (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  expected_count INTEGER NOT NULL CHECK(expected_count BETWEEN 1 AND 100),
  canonical_bytes BLOB NOT NULL,
  bytes_digest TEXT NOT NULL CHECK(bytes_digest = bytes_sha256(canonical_bytes)),
  finalized_id TEXT NOT NULL CHECK(finalized_id = id),
  created_token TEXT NOT NULL DEFAULT(command_token()),
  UNIQUE(id, project_id),
  FOREIGN KEY(finalized_id, project_id) REFERENCES finalizations(bundle_id, project_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE members (
  bundle_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  value TEXT NOT NULL,
  PRIMARY KEY(bundle_id, position),
  FOREIGN KEY(bundle_id, project_id) REFERENCES bundles(id, project_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE finalizations (
  bundle_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  UNIQUE(bundle_id, project_id),
  FOREIGN KEY(bundle_id, project_id) REFERENCES bundles(id, project_id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER bundle_context BEFORE INSERT ON bundles
  WHEN NEW.created_token <> command_token()
  BEGIN SELECT RAISE(ABORT, 'bundle must bind creating command'); END;
CREATE TRIGGER member_guard BEFORE INSERT ON members BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM finalizations WHERE bundle_id=NEW.bundle_id)
    THEN RAISE(ABORT, 'bundle already finalized') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM bundles b WHERE b.id=NEW.bundle_id
    AND b.project_id=NEW.project_id AND NEW.position < b.expected_count
    AND json_extract(CAST(b.canonical_bytes AS TEXT), '$[' || NEW.position || ']') IS NEW.value)
    THEN RAISE(ABORT, 'member must match exact artifact position') END;
END;
CREATE TRIGGER finalize_guard BEFORE INSERT ON finalizations BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM bundles b WHERE b.id=NEW.bundle_id
    AND b.project_id=NEW.project_id
    AND b.expected_count=json_array_length(CAST(b.canonical_bytes AS TEXT))
    AND b.expected_count=(SELECT count(*) FROM members WHERE bundle_id=b.id))
    THEN RAISE(ABORT, 'bundle requires complete member set') END;
END;
CREATE TRIGGER bundle_no_update BEFORE UPDATE ON bundles BEGIN SELECT RAISE(ABORT, 'immutable bundle'); END;
CREATE TRIGGER member_no_update BEFORE UPDATE ON members BEGIN SELECT RAISE(ABORT, 'immutable member'); END;
CREATE TRIGGER finalization_no_update BEFORE UPDATE ON finalizations BEGIN SELECT RAISE(ABORT, 'immutable finalization'); END;
CREATE TRIGGER bundle_no_delete BEFORE DELETE ON bundles
  WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
  BEGIN SELECT RAISE(ABORT, 'project erasure only'); END;
CREATE TRIGGER member_no_delete BEFORE DELETE ON members
  WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
  BEGIN SELECT RAISE(ABORT, 'project erasure only'); END;
CREATE TRIGGER finalization_no_delete BEFORE DELETE ON finalizations
  WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
  BEGIN SELECT RAISE(ABORT, 'project erasure only'); END;

-- Equivalent to the previously-committed promotion barrier, with no fake xmin.
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY NOT NULL,
  bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER handoff_guard BEFORE INSERT ON handoffs BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM bundles b JOIN finalizations f ON f.bundle_id=b.id
    WHERE b.id=NEW.bundle_id AND b.created_token <> command_token())
    THEN RAISE(ABORT, 'requires previously committed bundle') END;
END;

CREATE TRIGGER handoff_no_update BEFORE UPDATE ON handoffs BEGIN SELECT RAISE(ABORT, 'immutable handoff'); END;
CREATE TRIGGER handoff_no_delete BEFORE DELETE ON handoffs
  WHEN EXISTS(SELECT 1 FROM bundles b JOIN projects p ON p.id=b.project_id WHERE b.id=OLD.bundle_id)
  BEGIN SELECT RAISE(ABORT, 'immutable handoff'); END;

-- One row represents one logical external attempt, not a complete queue.
CREATE TABLE attempts (
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','claimed','started','completed','outcome_unknown')),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0),
  owner TEXT,
  expires_at INTEGER,
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls IN (0,1)),
  result BLOB,
  CHECK((state='ready' AND owner IS NULL AND expires_at IS NULL AND calls=0 AND result IS NULL)
    OR (state='claimed' AND owner IS NOT NULL AND expires_at IS NOT NULL AND calls=0 AND result IS NULL)
    OR (state='started' AND owner IS NOT NULL AND expires_at IS NOT NULL AND calls=1 AND result IS NULL)
    OR (state='completed' AND owner IS NULL AND expires_at IS NULL AND calls=1 AND result IS NOT NULL)
    OR (state='outcome_unknown' AND owner IS NULL AND expires_at IS NULL AND calls=1 AND result IS NULL))
) STRICT;
CREATE TRIGGER attempt_insert BEFORE INSERT ON attempts
  WHEN NEW.state <> 'ready' OR NEW.epoch <> 0
  BEGIN SELECT RAISE(ABORT, 'attempt must start ready'); END;
CREATE TRIGGER attempt_transition BEFORE UPDATE ON attempts BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NOT (
    (OLD.state IN ('ready','claimed') AND NEW.state='claimed' AND NEW.epoch=OLD.epoch+1
      AND (OLD.state='ready' OR OLD.expires_at <= command_time()) AND NEW.expires_at > command_time())
    OR (OLD.state='claimed' AND NEW.state='started' AND NEW.epoch=OLD.epoch
      AND NEW.owner=OLD.owner AND NEW.expires_at=OLD.expires_at AND OLD.expires_at > command_time())
    OR (OLD.state='started' AND NEW.state='completed' AND NEW.epoch=OLD.epoch AND OLD.expires_at > command_time())
    OR (OLD.state='started' AND NEW.state='outcome_unknown' AND NEW.epoch=OLD.epoch AND OLD.expires_at <= command_time())
  ) THEN RAISE(ABORT, 'invalid attempt transition') END;
END;
CREATE TRIGGER attempt_no_delete BEFORE DELETE ON attempts BEGIN SELECT RAISE(ABORT, 'retain attempt'); END;

-- Revalidate a mutable stream on every command (lineage-state deferred guard).
CREATE TABLE stream_events (
  scope TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  state TEXT NOT NULL CHECK(state IN ('open','closed')),
  token TEXT NOT NULL DEFAULT(command_token()),
  PRIMARY KEY(scope, sequence),
  FOREIGN KEY(scope, token) REFERENCES stream_validations(scope, token) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE stream_validations (
  scope TEXT NOT NULL,
  token TEXT NOT NULL DEFAULT(command_token()),
  head INTEGER NOT NULL,
  PRIMARY KEY(scope, token),
  FOREIGN KEY(scope, head) REFERENCES stream_events(scope, sequence)
) STRICT;
CREATE TRIGGER stream_event_guard BEFORE INSERT ON stream_events BEGIN
  SELECT CASE WHEN NEW.token <> command_token()
    OR EXISTS(SELECT 1 FROM stream_validations WHERE scope=NEW.scope AND token=NEW.token)
    OR NEW.sequence <> 1 + coalesce((SELECT max(sequence) FROM stream_events WHERE scope=NEW.scope),0)
    OR (SELECT state FROM stream_events WHERE scope=NEW.scope ORDER BY sequence DESC LIMIT 1)='closed'
    THEN RAISE(ABORT, 'invalid stream append') END;
END;
CREATE TRIGGER stream_validate_guard BEFORE INSERT ON stream_validations BEGIN
  SELECT CASE WHEN NEW.token <> command_token()
    OR NEW.head IS NOT (SELECT max(sequence) FROM stream_events WHERE scope=NEW.scope)
    OR NOT EXISTS(SELECT 1 FROM stream_events WHERE scope=NEW.scope AND sequence=NEW.head AND token=NEW.token)
    THEN RAISE(ABORT, 'must validate current command head') END;
END;
CREATE TRIGGER stream_event_no_update BEFORE UPDATE ON stream_events BEGIN SELECT RAISE(ABORT, 'immutable event'); END;
CREATE TRIGGER stream_event_no_delete BEFORE DELETE ON stream_events BEGIN SELECT RAISE(ABORT, 'immutable event'); END;
CREATE TRIGGER stream_validation_no_update BEFORE UPDATE ON stream_validations BEGIN SELECT RAISE(ABORT, 'immutable validation'); END;
CREATE TRIGGER stream_validation_no_delete BEFORE DELETE ON stream_validations BEGIN SELECT RAISE(ABORT, 'immutable validation'); END;
