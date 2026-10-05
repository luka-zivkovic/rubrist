# Milestone 3 progress

CURRENT 2026-10-05. This branch is an incomplete Milestone 3 implementation.
No Milestone 3 PR or deployment is qualified by this checkpoint. Milestone 2
PR #194 is awaiting fresh CI and Copilot review after its collection, queue-validation and error-transport follow-ups.

## Independently reviewed foundation

- Atomic bulk collection-example import and immutable collection revisions,
  canonical digests, pre-redaction identities, finalization and exposures.
- Exact-byte native suite manifests and persisted run-comparison bindings.
- Durable capability checks with credential/project scope, one-hour expiry and
  stable insertion ordering. Atomic provider-resolution attempts and records,
  exact binding reads, failed-record persistence and version-save protection.
- Ungoverned review queues with exact recorded-result pins, assignments,
  idempotent human submissions, atomic task completion and account anonymization.
  UUID submissions use PostgreSQL-equivalent lowercase identity.
- Human/imported verdicts, scoped agreement/disagreement, self-consistency,
  audit reads and paginated convergence. Convergence snapshot membership uses
  an immutable AUTOINCREMENT sequence, preventing later same-millisecond
  verdicts from entering earlier pages; latest heads still use timestamp/ID.
- Visible golden promotion and retirement atomically maintain canonical
  regression revisions. Label conflicts, criterion binding, pre-redaction
  identity, exposure history and historical snapshots are retained.

- Revision-bound evaluations and exposure records, cached/empty completion,
  automatic-import/convergence/backfill deduplication and run comparisons.
  First-assessment listing includes backfills; provider authorization records
  retain the correct execution context.
- Trace-derived test drafts, append-only revisions and validations, enablement,
  retained redacted sources, source-pinned runs, reviewer anonymization and
  deduplicated journey events.
- LangSmith/Langfuse/Ironside configuration with encrypted credentials, exact
  version selection, serialized poll claims, failure records, Ironside cursor
  CAS, quarantine and connection-revision revalidation. Import-job lifecycle,
  tenant-scoped remote trace/version identities and pointer cleanup match PG.
- Feedback jobs and contexts for all three providers, durable blocked/retry/
  terminal states and atomic coverage updates. Tests use no external sends.

## Migration ownership

TARGET within accepted ADR-0016: migration work is separate from runtime
connections. CURRENT: a dedicated startup connection disables FK actions before
its BEGIN IMMEDIATE, applies forward migrations, checks all foreign keys and
unfinished replacement/temporary tables, commits, then restores enforcement.
Application connections open independently with FK enforcement enabled.

Claude Code was consulted through agent-bridge. Its synthetic experiments on
the M2 schema showed that deferred FK enforcement does not suppress DROP TABLE
cascade actions. Explicit table rebuilding with FK actions disabled on the
migration-only connection preserves the graph. This is an implementation of
ADR-0016, not an ADR amendment. Applied migrations 0001–0006 are unchanged.

Independent audit additionally found that migration SQL could COMMIT before
validation. The runner now denies transaction/savepoint control through the
SQLite authorizer during migration statements, retaining sole ownership of
commit/rollback. Replacement copies preserve explicit columns and rowids and
assert count/value equality before swapping tables. SQL dependent triggers are
recreated explicitly; no historical evidence is recanonicalized.

## Validation at this checkpoint

CURRENT: Node 24.15.0, SQLite 3.51.3. API typecheck passed. The earlier foundation **81 tests in
12 SQLite files passed** with two workers. Focused independent audits reviewed
all foundation groups listed above; their actionable findings were fixed and
rechecked. Synthetic migration tests cover rollback and SIGKILL after copy,
mid-swap, before ledger and after commit. A real M2-to-current migration fixture
compares every prior row/checksum and retained receipt BLOB after upgrading.

Not yet qualified: full application/PostgreSQL regression, final method/task
parity inventory, independent whole-milestone audit, CI and Copilot review.

## Remaining Milestone 3 work

Evaluator version editing and regression ownership; production monitoring storage/retention; dashboard,
onboarding and trace retention; historical gate compatibility; remaining job
registration and scheduled recovery. Advanced governed repositories remain
Milestone 4. Ordinary HTTP staging is not lifted by this partial checkpoint.


The expanded ordinary-workflow slice has independent approval after correcting
first-assessment filtering, backfill authorization context, retained reviewer
anonymization and the import-job live integration pointer. API typecheck passes.
All **91 tests in 14 SQLite files passed** before this checkpoint. A source
inventory currently counts 152/165 main repository methods wired; wiring alone
is not end-to-end parity, and specialist/worker coverage remains outstanding.
