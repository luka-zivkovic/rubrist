-- ADR-0013: ungoverned production feedback, never evaluator evidence.
ALTER TABLE projects ADD COLUMN production_record_retention_days INTEGER NOT NULL DEFAULT 90 CHECK(production_record_retention_days BETWEEN 1 AND 730);
CREATE TABLE production_decision_records (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('decision','action','outcome')),decision_id TEXT NOT NULL CHECK(length(decision_id)>0 AND length(CAST(decision_id AS BLOB))<=16384),
 record_at TEXT NOT NULL,content TEXT NOT NULL CHECK(json_valid(content) AND json_type(content)='object' AND length(CAST(content AS BLOB))<=262144),content_digest TEXT NOT NULL,
 submitted_by_api_key_id TEXT,submitted_by_user_id TEXT,received_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK((submitted_by_api_key_id IS NULL)<>(submitted_by_user_id IS NULL)),UNIQUE(project_id,content_digest)
) STRICT;
CREATE UNIQUE INDEX production_decision_identity ON production_decision_records(project_id,decision_id) WHERE kind='decision';
CREATE INDEX production_record_window ON production_decision_records(project_id,record_at,received_at,content_digest);
CREATE INDEX production_record_decision ON production_decision_records(project_id,decision_id);
CREATE TABLE production_decision_tombstones (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,decision_id_digest TEXT NOT NULL,erased_by_user_id TEXT NOT NULL,erased_at TEXT NOT NULL,
 PRIMARY KEY(project_id,decision_id_digest),CHECK(length(decision_id_digest)=71 AND substr(decision_id_digest,1,7)='sha256:' AND substr(decision_id_digest,8) NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE production_calibration_snapshots (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 report_contract TEXT NOT NULL CHECK(report_contract='rubrist/production-calibration/v1'),canonical_bytes BLOB NOT NULL CHECK(length(canonical_bytes) BETWEEN 1 AND 16777216),artifact_digest TEXT NOT NULL,
 window_from TEXT,window_to TEXT,parameters TEXT NOT NULL CHECK(json_valid(parameters) AND json_type(parameters)='object' AND length(CAST(parameters AS BLOB))<=65536),
 record_count INTEGER NOT NULL CHECK(record_count>=0),record_set_digest TEXT NOT NULL CHECK(length(record_set_digest)=71 AND substr(record_set_digest,1,7)='sha256:' AND substr(record_set_digest,8) NOT GLOB '*[^0-9a-f]*'),
 built_at TEXT NOT NULL,created_by_user_id TEXT NOT NULL,created_at TEXT NOT NULL,
 CHECK(window_from IS NULL OR window_to IS NULL OR julianday(window_from)<julianday(window_to))
) STRICT;
CREATE TRIGGER production_record_validate BEFORE INSERT ON production_decision_records BEGIN
 SELECT CASE WHEN sqlite_production_record_valid(NEW.kind,NEW.decision_id,NEW.record_at,NEW.content,NEW.content_digest)<>1 THEN RAISE(ABORT,'production record content mismatch') END;
 SELECT CASE WHEN julianday(NEW.received_at) IS NULL OR NEW.received_at<>strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN RAISE(ABORT,'production receive time must be database time') END;
 SELECT CASE WHEN NEW.record_at>sqlite_production_timestamp(strftime('%Y-%m-%dT%H:%M:%fZ',NEW.received_at,'+5 minutes')) THEN RAISE(ABORT,'future production record') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM production_decision_tombstones WHERE project_id=NEW.project_id AND decision_id_digest=sqlite_production_text_digest(NEW.decision_id)) THEN RAISE(ABORT,'erased production decision') END;
END;
CREATE TRIGGER production_snapshot_validate BEFORE INSERT ON production_calibration_snapshots WHEN sqlite_production_snapshot_valid(NEW.canonical_bytes,NEW.artifact_digest,NEW.report_contract,NEW.window_from,NEW.window_to,NEW.built_at)<>1
BEGIN SELECT RAISE(ABORT,'production snapshot bytes mismatch'); END;
CREATE TRIGGER production_record_immutable BEFORE UPDATE ON production_decision_records BEGIN SELECT RAISE(ABORT,'immutable production record'); END;
CREATE TRIGGER production_snapshot_immutable BEFORE UPDATE ON production_calibration_snapshots BEGIN SELECT RAISE(ABORT,'immutable production snapshot'); END;
CREATE TRIGGER production_tombstone_immutable BEFORE UPDATE ON production_decision_tombstones BEGIN SELECT RAISE(ABORT,'immutable production tombstone'); END;
CREATE TRIGGER production_record_delete BEFORE DELETE ON production_decision_records WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT CASE WHEN sqlite_production_deletion_allowed()<>1 THEN RAISE(ABORT,'production record deletion requires audited command') END; END;
CREATE TRIGGER production_snapshot_delete BEFORE DELETE ON production_calibration_snapshots WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT CASE WHEN sqlite_production_deletion_allowed()<>1 THEN RAISE(ABORT,'production snapshot deletion requires audited command') END; END;
CREATE TRIGGER production_tombstone_delete BEFORE DELETE ON production_decision_tombstones WHEN EXISTS(SELECT 1 FROM projects WHERE id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'production tombstone deletion requires project erasure'); END;
