-- Managed-command identity is private process state, never caller supplied.
-- A persistent clock prevents a later exposure from looking earlier after a
-- server clock correction. Times are non-decreasing UTC milliseconds.
CREATE TABLE rubrist_command_clock (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 last_ms INTEGER NOT NULL CHECK(last_ms>=0)
) STRICT;
INSERT INTO rubrist_command_clock VALUES(1,coalesce((
 SELECT cast(round(max(unixepoch(stamp,'subsec'))*1000) AS INTEGER) FROM (
  SELECT occurred_at stamp FROM dataset_exposure_events UNION ALL SELECT created_at FROM cases
 )
),0));
CREATE TRIGGER rubrist_command_clock_update BEFORE UPDATE ON rubrist_command_clock BEGIN
 SELECT CASE WHEN sqlite_clock_write_allowed()<>1 OR NEW.singleton<>OLD.singleton OR NEW.last_ms<OLD.last_ms
  THEN RAISE(ABORT,'managed monotonic command clock required') END;
END;
CREATE TRIGGER rubrist_command_clock_insert BEFORE INSERT ON rubrist_command_clock BEGIN SELECT RAISE(ABORT,'command clock already initialized'); END;
CREATE TRIGGER rubrist_command_clock_delete BEFORE DELETE ON rubrist_command_clock BEGIN SELECT RAISE(ABORT,'command clock cannot be deleted'); END;
CREATE TRIGGER dataset_exposure_command_time BEFORE INSERT ON dataset_exposure_events BEGIN
 SELECT CASE WHEN NEW.occurred_at<>sqlite_command_time() THEN RAISE(ABORT,'exposure time must belong to current command') END;
END;
-- Ingestion stays server-owned and fixed-width for serialized freeze ordering.
CREATE TRIGGER case_command_time BEFORE INSERT ON cases BEGIN
 SELECT CASE WHEN NEW.created_at<>sqlite_command_time() THEN RAISE(ABORT,'ingestion time must belong to current command') END;
END;
