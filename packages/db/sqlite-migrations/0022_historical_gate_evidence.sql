-- Deprecated historical compatibility storage; no public release-policy route.
CREATE UNIQUE INDEX golden_project_identity ON golden_set_entries(project_id,id);
CREATE TABLE gate_checks (
 id TEXT PRIMARY KEY NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 skill_version_id TEXT NOT NULL,eval_run_id TEXT NOT NULL,label TEXT,metadata TEXT NOT NULL CHECK(json_valid(metadata)),
 max_disagreements INTEGER NOT NULL CHECK(max_disagreements>=0),created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,created_at TEXT NOT NULL,
 UNIQUE(project_id,id),FOREIGN KEY(project_id,skill_version_id) REFERENCES skill_versions(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,eval_run_id) REFERENCES eval_runs(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE gate_check_items (
 id TEXT PRIMARY KEY NOT NULL,gate_check_id TEXT NOT NULL,project_id TEXT NOT NULL,
 golden_entry_id TEXT NOT NULL,golden_case_id TEXT NOT NULL,candidate_case_id TEXT NOT NULL,case_key TEXT NOT NULL,
 expected_label TEXT NOT NULL CHECK(expected_label IN ('pass','fail')),created_at TEXT NOT NULL,
 UNIQUE(gate_check_id,golden_case_id),FOREIGN KEY(project_id,gate_check_id) REFERENCES gate_checks(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,golden_entry_id) REFERENCES golden_set_entries(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,golden_case_id) REFERENCES cases(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,candidate_case_id) REFERENCES cases(project_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX gate_checks_project_time ON gate_checks(project_id,created_at DESC,id DESC);
CREATE TRIGGER historical_gate_run_binding BEFORE INSERT ON gate_checks WHEN NOT EXISTS(SELECT 1 FROM eval_runs WHERE id=NEW.eval_run_id AND project_id=NEW.project_id AND skill_version_id=NEW.skill_version_id)
BEGIN SELECT RAISE(ABORT,'historical gate run binding mismatch'); END;
CREATE TRIGGER historical_gate_item_binding BEFORE INSERT ON gate_check_items WHEN NOT EXISTS(
 SELECT 1 FROM gate_checks g JOIN eval_run_items i ON i.eval_run_id=g.eval_run_id AND i.project_id=g.project_id WHERE g.id=NEW.gate_check_id AND g.project_id=NEW.project_id AND i.case_id=NEW.candidate_case_id)
BEGIN SELECT RAISE(ABORT,'historical gate item binding mismatch'); END;
