-- Short-lived server-side probe results. Existing evidence is untouched.
CREATE TABLE evaluator_capability_checks (
  id text PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  context_digest text NOT NULL,
  checked_at timestamptz NOT NULL,
  classification boolean NOT NULL,
  check_result jsonb NOT NULL CHECK (jsonb_typeof(check_result) = 'object')
);
CREATE INDEX evaluator_capability_checks_lookup
  ON evaluator_capability_checks(project_id, context_digest, checked_at, sequence);
CREATE INDEX evaluator_capability_checks_expiry ON evaluator_capability_checks(checked_at);
