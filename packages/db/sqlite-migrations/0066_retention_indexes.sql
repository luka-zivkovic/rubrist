-- Retention's correlated protection probes must use exact case lookups.
-- The Milestone 6 5,000-case workload exposed repeated project-wide scans.
-- These are access-path changes only: all guards and preserved data remain.
CREATE INDEX dataset_revision_source_case
  ON dataset_revision_items(project_id,source_case_id);
CREATE INDEX raw_traces_retention_time
  ON raw_traces(project_id,created_at,id);
CREATE INDEX review_queue_case_evidence
  ON review_queue_items(project_id,case_id) WHERE judge_run_id IS NOT NULL;
CREATE INDEX verdict_review_case
  ON verdicts(project_id,case_id) WHERE review_queue_item_id IS NOT NULL;
CREATE INDEX golden_retention_case
  ON golden_set_entries(project_id,case_id) WHERE retired_at IS NULL;
