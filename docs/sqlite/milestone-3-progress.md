# Milestone 3 ordinary workflows

CURRENT 2026-10-05: the ordinary workflow implementation and independent audit
and local qualification are complete; PR CI/Copilot review is pending.
Milestone 2 PR #194 remains the predecessor until merged. No deployment is included.
The [method and task checklist](milestone-3-checklist.md) maps all 165 main
repository methods, production monitoring, capability resolution, and ordinary
scheduled work to native implementations and backend tests.

## Implemented behavior

- Atomic collection imports, immutable revisions and exposures; exact-byte suite
  manifests, run comparisons and retained historical gate evidence.
- Human/imported verdicts, legacy review queues, pinned reviewer submissions,
  legacy adjudicated verdict storage, account anonymization and stable paginated
  convergence.
- Golden promotion/retirement with frozen regression revisions, trace-derived
  tests, immutable validations, enabled revisions and retained source pins.
- Evaluator authoring, sign-off, onboarding replay, real-provider starter creation
  and existing empty-project upgrades. Missing credentials refuse execution.
- Durable regression attempt ownership with token/epoch fencing, heartbeats and
  immutable final outcomes. No SQLite write transaction spans provider requests.
  Expired attempts retain an operational uncertainty count; whole-attempt retries
  preserve the existing regression contract. This differs deliberately from
  release-evidence item recovery, which does not dispatch a second model call.
- All three trace integrations, encrypted credentials, exact-version imports,
  polling claims, Ironside cursor CAS/revalidation/quarantine, feedback state and
  atomic coverage counters. Workers and pollers run for both persistent backends.
- Production monitoring records, exact snapshot bytes, full-window limits,
  microsecond ordering, retention, digest-only tombstones, erasure and deletion
  audits. Monitoring never creates governed assessment evidence.
- Project dashboards, onboarding inventory and trace retention protect frozen,
  golden, review-pinned and assessment-receipt evidence. Deletion/counters/audits
  commit atomically.

The main runtime is fully typed as `RubristRepository`, with no missing-method
proxy or demo fallback. Advanced analysis, governed review, lifecycle and binary
calibration specialist repositories remain Milestone 4. Installation templates
and release qualification remain Milestones 5–6.

## Migration and execution ownership

TARGET follows accepted ADR-0016. CURRENT migration work uses a dedicated
connection with FK actions disabled before BEGIN IMMEDIATE. Explicit table
rebuilds preserve columns, rowids and retained BLOBs, check copy equality, recreate
dependent triggers, verify foreign keys and reject unfinished replacement tables
before commit. Runtime connections separately enable FK enforcement. Migration
SQL cannot issue transaction/savepoint commands behind the runner's ownership.
Applied migrations 0001–0010 remain unchanged; this milestone adds 0011–0025.
The unpublished M3 filenames were advanced after M2 added its forward
membership and terminal metadata guards; only disposable qualification
databases existed.

Claude Code was consulted through agent-bridge. Its synthetic migration probe
confirmed that deferred foreign keys do not prevent DROP TABLE cascades. Its
regression review confirmed that attempt-level ownership preserves the existing
whole-golden-set retry contract without an ADR change. Resulting fixes also stop
new parallel regression dispatch after the first failure, drain already-started
calls, prevent failed gates from scheduling backfill, and make the PostgreSQL
failure finalizer respect the execution owner's advisory lock.

All ordinary scheduled tasks now stop future ticks and drain active work before
queue/storage shutdown. Recovery uses durable rows after downtime. Production
retention uses fixed elapsed days on both backends; PostgreSQL's previous
calendar-day interval could shift the cutoff across a daylight-saving change.

## Validation

CURRENT tested runtime: Node 24.15.0, SQLite 3.51.3 and disposable PostgreSQL 17.
Independent audits covered each implementation slice and the cumulative diff.
Actionable findings (including starter upgrades, microsecond ordering and active
recovery shutdown) were corrected and rechecked.

Synthetic tests include direct-write rejection, account erasure, concurrent
claims and submissions, rollback injection, exact-byte retention, SIGKILL during
migration/provider dispatch/finalization, authenticated startup/editing, and
queued imports surviving restart for LangSmith/Langfuse/Ironside with controlled
clients and feedback writers. The M2-to-current migration fixture checks old
rows/checksums and retained receipt bytes. PostgreSQL ownership and a fixed
cross-DST retention fixture cover shared compatibility fixes.

Consolidated validation: **2,343/2,343 Vitest tests in 309 files passed**, with
`PG_SMOKE_DATABASE_URL` pointing to disposable PostgreSQL 17; no skipped database
tests were counted. **53/53 tooling tests passed**. Repository-wide typecheck,
shared-contract and repository-boundary guards, web production build, and
`git diff --check` passed. The web build retains its existing large-bundle advisory.
The complete SQLite run passed **120 tests in 19 files**; the later explicit
dispatch/receipt contract test and inherited M2 staging test also passed in focused
runs. A final authenticated M3 test confirms version history includes its retained
regression outcome after the M2 staging restriction is lifted.

Real customer data and paid provider calls were not used. PR links and hosted
CI/Copilot results are recorded after opening the milestone PR.

CURRENT: M3 migrations now follow M2 terminal metadata guard 0009. Both evaluation-table rebuilds preserve immutable terminal start time and blocking metadata.

CURRENT rebase validation: independent audit verifies unchanged M2 migration bytes and preserved terminal metadata guards in both M3 rebuilds. Evaluation and interrupted-rebuild tests pass 26/26.

CURRENT: M3 now follows correction-reason guard 0010; its migrations do not rebuild receipt tables or remove that guard.
