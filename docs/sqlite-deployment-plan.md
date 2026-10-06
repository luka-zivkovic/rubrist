# Rubrist SQLite deployment implementation plan

Prepared on 2026-10-04 for implementation in a separate session.

Status: Milestone 4 specialist workflows locally qualified; PR review pending (2026-10-06). The
user agreed to two fixed deployment options for the same application. Isolated
integrity/recovery prototypes, persistent accounts, native evaluations, ordinary
workflows and specialist repositories are implemented; installation/release
qualification remains incomplete. This document
records that TARGET, the audited CURRENT state, and proposed implementation
choices. It does not replace `PRODUCT.md` or accepted evidence contracts.

Repository: `/Users/makina/ai-trust/coeval`, the project now named Rubrist.
Audit baseline: `8cabae2ac7a4c70e5812cd85b35b5cfc7c678311`. Recheck the checkout
and working tree before using the inventory below.

## Agreed deployment scope

TARGET: ship two installation templates. Each template automatically selects
and configures one database for all persistent application state, including
accounts, sessions, memberships, integration credentials, evidence, and jobs.

| Installation | Application storage and authentication | Background execution |
| --- | --- | --- |
| SQLite | One persistent SQLite database on the application host; Better Auth uses it too | Application-managed execution with durable job records in the same database |
| PostgreSQL | PostgreSQL; Better Auth uses the selected PostgreSQL database | Retain the existing PostgreSQL job implementation unless a specific compatibility fix is needed |

The user chooses an installation template, launches it, and creates an account.
There is no database-selection screen inside Rubrist and no separate selection
of authentication or queue storage. Both installations run the same product
code and expose the same supported UI, API, and harness integrations.

The initial SQLite support boundary is one application instance on one host
with durable local storage. Multiple people may use that instance. Concurrent
model requests are permitted; database writes still need serialization. The
existing web and API components may remain separate containers. This work does
not require combining them into one image.

The selected backend stays fixed. A failed PostgreSQL connection must never
fall back to SQLite, and a failed persistent database must never fall back to
demo mode. Existing PostgreSQL installations must keep their data and behavior.

## Scope boundaries

Full parity means parity with currently implemented Rubrist features, including
advanced analysis, governed review, calibration, and production monitoring.
Unimplemented roadmap features are not added by this project.

The first release does not require automatic database conversion, live backend
switching, mixed database deployments, distributed SQLite workers, or sharing
a SQLite file across hosts. Cloudflare Workers, D1, and an ephemeral-container
storage solution are separate projects. Ordinary SQLite support does not
establish Cloudflare compatibility.

Keep the existing product boundaries: Rubrist owns evaluation and evidence;
Dailies owns release decisions; Casefile owns static capability intake. Do not
add semantic clustering, merge portfolio products, or redesign the UI as part
of this work.

The LangTracer pilot and its potentially sensitive data remain paused until
the user resumes that work. Use synthetic fixtures for this implementation.
Do not reuse credentials from the conversation or fetch pilot data.

## Current evidence and limitations

CURRENT at the audit baseline:

- The application uses Hono, Node, PostgreSQL repositories, Better Auth 1.6.22,
  and `pg-boss` 12.18.1. No persistent SQLite repository exists.
- Four application migration files contain 105 table definitions, 205 distinct
  SQL function names, and 182 trigger definitions, including 19 deferred
  constraint triggers. There are about 20,000 migration lines. These counts
  exclude tables created separately by the queue and migration bookkeeping.
- The main repository exposes 17 interfaces with approximately 165 method
  declarations. Eight specialist repository interfaces cover additional
  analysis, review, lifecycle, calibration, and monitoring behavior.
- `vitest.pg.config.ts` selects 41 database test files. The default test command
  can skip database coverage without its database environment.
- Several routes and request services use the existence of `pool` as a proxy
  for persistent mode, owner authorization, real providers, or feature support.
- Analysis population provenance includes a PostgreSQL-specific
  `snapshotXid8` field. Some database guards also use transaction identifiers,
  snapshot functions, or PostgreSQL transaction settings.
- The regression gate holds a PostgreSQL session advisory lock across model
  work. It cannot be replaced with a SQLite write transaction across that work.

VERIFIED experiment: the installed Better Auth version performed signup,
password login, and session storage with Rubrist's current `createAuth`
configuration on an isolated in-memory SQLite database. The runtime was Node
24.15.0 with SQLite 3.51.3. Rubrist's snake_case auth field mappings worked.
This was a runtime experiment, not a typechecked SQLite implementation. It did
not verify disk persistence, account bootstrap, memberships, or agent pairing.
No existing database was accessed and no application file was changed.

## Files to inspect before implementation

Read [AGENTS.md](../AGENTS.md), [PRODUCT.md](../PRODUCT.md),
[the glossary](glossary.md), [the ADR index](decisions/README.md), relevant
accepted ADRs, [implementation batches](implementation-batches.md),
[README](../README.md), and [architecture](architecture.md).

Preserve the hosted-review exception in
[ADR 0011](decisions/0011-prelaunch-blank-slate-database-policy.md). Do not reset
an existing database or rewrite applied PostgreSQL migration checksums.
[ADR 0006](decisions/0006-receipt-artifact-storage-and-freeze.md) names PostgreSQL
`bytea` for exact evidence storage; document the equivalent SQLite storage
representation while retaining the same canonical bytes and guarantees.

| Area | Starting points |
| --- | --- |
| Runtime composition | `apps/api/src/index.ts`, `apps/api/src/app.ts`, `apps/api/src/request-services/index.ts` |
| Main storage | `apps/api/src/repository.ts`, `repository/ports.ts`, `repository.pg.ts`, `repository.pg/` |
| Specialist storage | `apps/api/src/{analysis-population,analysis-study,analysis-promotion,analysis-measurement,governed-review,binary-calibration,evaluator-lifecycle,production-calibration}/` |
| Accounts and agent setup | `apps/api/src/lib/auth.ts`, `routes/v1-agent-administration.ts`, `routes/project-administration.ts` |
| Credentials and provider assistance | `apps/api/src/lib/encryption.ts`, `lib/capability-check-store.ts`, `evaluator-lifecycle/resolution.pg.ts` |
| Migrations | `packages/db/src/migrate.ts`, `packages/db/migrations/` |
| Jobs and recovery | `packages/queue/src/index.ts`, `apps/api/src/workers/eval-run.ts`, integration pollers, calibration orchestration, analysis deadlines, production retention |
| Integrity and transactions | `docs/repository-boundaries.md`, `tools/repository-boundaries.json`, schema guards, shared canonicalization helpers |
| Public snapshot provenance | `packages/shared/src/analysis-population.ts`, `apps/api/src/analysis-population/repository.pg.ts` |
| Tests and releases | `vitest.pg.config.ts`, `apps/api/test/`, `tools/test-postgres.ts`, `.github/workflows/ci.yml`, `.github/workflows/release.yml` |
| Distribution | `apps/api/Dockerfile`, `deploy/self-host/compose.yaml`, `deploy/coolify.yaml`, `docs/self-hosting.md` |

Some main repository slices instantiate specialist PostgreSQL repositories
internally. Inspect those dependencies as well as imports in startup code.

## Proposed implementation approach

ASSUMPTION: retain Node and the current application architecture. Select one
backend bundle at startup containing repositories, account-management services,
authentication storage, migrations, background jobs, and cleanup hooks. Route
handlers should depend on services and explicit runtime mode, not `pg.Pool`.
Reuse existing interfaces rather than inventing a universal SQL abstraction.

Use two fixed deployment templates. Keep the current PostgreSQL template and
add a SQLite template, for example `deploy/self-host/compose.sqlite.yaml`.
Names and configuration keys are proposed, not existing commands. Templates
should set the backend explicitly. Preserve compatibility with existing
`DATABASE_URL` installations. Decide and test how direct developer startup
selects demo mode; absence of a PostgreSQL URL must not imply unauthenticated
SQLite. Make ambiguous or contradictory configuration fail with a clear error.

Keep Better Auth for both backends. The built-in Node SQLite driver is a
candidate demonstrated by the authentication experiment; choose and pin a
supported runtime after checking transaction handling, backup support,
platform packaging, and event-loop impact. An ORM migration is not a
prerequisite and would not port database functions or integrity constraints.

Use separate backend migration histories. Share domain calculations and
canonicalization where useful, but preserve backend-specific transactions,
queries, error mapping, and database-enforced integrity. Do not translate SQL
with string replacement or turn DemoRepository into the production backend.

For SQLite, explicitly configure and verify foreign keys, journal/durability
settings, busy handling, and connection ownership. Use short write
transactions. Prevent asynchronous requests from accidentally sharing another
request's open transaction. Evaluate a serialized database executor or worker
thread for blocking queries; do not hold write transactions during model or
integration network calls.

## Milestone 0 Resolve the difficult design cases

CURRENT checkpoint (2026-10-05): see [design and results](sqlite/milestone-0.md),
[complete source invariant inventory](sqlite/invariant-inventory.json), and
[validation/review record](sqlite/milestone-0-validation.md). Disk-backed tests
cover deferred immutable and per-command completeness, direct invalid writes,
BLOB retention/backup, WAL isolation, commit barriers and SIGKILL recovery with
fenced execution. [ADR-0016](decisions/0016-sqlite-deployment-and-provenance.md)
records the accepted storage/provenance refinements (approved after Milestone 1); no public contract
or application runtime changed in that milestone. Milestone 1 adds the account
runtime described below; later milestones remain unimplemented.
Independent review is complete with findings resolved. Full non-PG validation
passes after a two-worker rerun; PostgreSQL validation could not start because
Docker is stopped. This is a reviewed Milestone 0 checkpoint, not product parity.
Updated planning allowance: 55–85 engineer-days total; see the design's rationale.


- Refresh the audit, read current diffs, and preserve unrelated work. Create
  an isolated implementation branch or worktree when needed.
- Record the deployment architecture and any narrowly required ADR changes.
  Separate the user-approved deployment scope from unresolved technical
  choices. Existing unrelated roadmap gates are not new SQLite requirements.
- Build an invariant inventory: for each PostgreSQL function/trigger, record
  its business purpose, SQLite enforcement strategy, and validation test.
  Repetitive functions may share an implementation but must retain coverage.
- Prototype a deferred completeness rule and direct invalid-write rejection
  on SQLite. Evaluate finalization records, immediate triggers, and deferred
  foreign keys as appropriate. Application-only checks must not silently
  replace promised database enforcement.
- Specify snapshot provenance that honestly describes each backend. Assess
  schema versions, existing readers, stored artifacts, and digest impact.
  Never synthesize a fake PostgreSQL snapshot identifier for SQLite.
- Prototype durable execution ownership across a model-call boundary, including
  interruption before dispatch and uncertainty after dispatch.

Completion: reviewed designs and executable isolated tests demonstrate viable
replacements for the difficult constraints, provenance, and execution ownership.
Update the effort estimate using those results. If equivalent guarantees cannot
be preserved, present the concrete tradeoff rather than silently weakening them.

## Milestone 1 Establish persistent SQLite startup and authentication

CURRENT checkpoint (2026-10-05): [implementation boundary](sqlite/milestone-1.md)
and [validation/review record](sqlite/milestone-1-validation.md). Explicit backend
selection, a serialized SQLite worker, ordered checksummed migrations, shared
account services, browser auth, memberships, invitations, keys and pairing
lifecycle are implemented. This is an account-stage development runtime;
unported workflows fail explicitly with 503. Full evaluator/bootstrap execution
and integration storage remain later milestones, not fabricated demo behavior.


- Implement backend selection, SQLite connection lifecycle, separate migration
  execution, and the minimum account/project schema for this slice.
- Make migrations ordered, checksummed, retryable, and safe against incompatible
  histories or competing startup attempts. Verify foreign keys on every
  connection and preserve existing PostgreSQL migration history.
- Remove `pool`-based authorization and demo inference from shared routing.
  Use an explicit authenticated persistent runtime and injected account services.
- Port first-owner creation and recovery, workspace/project creation,
  membership lookup, invitations, API-key records, and agent pairing with
  existing expiration, one-time use, and race protections.
- Preserve provider/integration credential encryption and its dependence on
  `BETTER_AUTH_SECRET`. Maintain the existing browser authentication experience.

Completion: both backend configurations pass signup/login/logout, restart,
membership isolation, owner/member permissions, API-key revocation, invitation,
and agent-pairing tests. SQLite startup requires no PostgreSQL connection.
Malformed persistent configuration cannot enter demo mode.

## Milestone 2 Deliver one durable evaluation workflow

CURRENT implementation on `sqlite-milestone-2` includes durable queue commands,
native criterion/evaluator definitions, trace ingestion, mutable collections,
fenced evaluation execution and atomic receipt artifacts. The synthetic HTTP
workflow covers setup, native authoring, batch submission, restart, evaluation
and exact-byte receipt retrieval. The [validation record](sqlite/milestone-2-validation.md)
tracks independent audit, regression checks and PR review. This slice is not
complete application parity.

- Port the storage needed for projects, criteria, evaluator versions,
  credentials, imported traces/cases, datasets, evaluation runs/items,
  immutable receipts, and required audit records.
- Normalize JSON, timestamps, booleans, binary data, ordering, null semantics,
  query limits, and constraint errors. Preserve transaction ownership described
  in `docs/repository-boundaries.md`.
- Implement the SQLite job behavior Rubrist requires behind the queue interface:
  stable identifiers, deduplication, atomic claiming, lease/ownership checks,
  bounded retries/backoff, expiry, terminal states, and state lookup.
- Preserve durable dispatch/outbox behavior and distinguish queue delivery
  retries from permission to call a model again. Completion must reject a stale
  worker whose ownership has expired or been replaced.
- Run signup, import, evaluation, interruption, restart, and receipt retrieval
  as an end-to-end slice. Persist exact receipt bytes in the transaction that
  terminalizes the run.

Completion: a deterministic synthetic evaluation survives supported restart
points without losing jobs or recording duplicate terminal evidence. A crash
after provider dispatch records uncertainty where required; it does not promise
exactly-once external model calls. Ordinary parallel evaluations remain possible.
This milestone is not a claim of complete product parity.

## Milestone 3 Complete ordinary workflows and integrations

CURRENT: implementation, independent audit and local qualification complete;
PR CI/Copilot review pending. See the [implementation record](sqlite/milestone-3-progress.md)
and [165-method/task checklist](sqlite/milestone-3-checklist.md). Advanced
specialist repositories remain Milestone 4.

- Complete the remaining main repository ports: datasets and revisions,
  golden examples, review queues, trace-derived tests, evaluator regression,
  run comparison, feedback, and retained historical evidence reads.
- Replace the regression runner's session advisory lock with durable execution
  ownership that does not hold a SQLite write lock across model requests.
- Port LangSmith, Langfuse, and optional Ironside configuration/imports,
  cursor compare-and-set, poll claims, quarantine, and feedback sync.
- Port provider resolution records and capability-check storage with existing
  expiration, credential scope, and version binding.
- Complete all required queue names and scheduled/recovery tasks. A scheduled
  task must recover correctly after downtime and shutdown.
- Port production decision records, reports/snapshots, retention, tombstones,
  explicit erasure, counters, and deletion audit behavior.

Completion: a feature checklist maps every main repository method and scheduled
task to its implementation and backend test. Integration tests use controlled
test services or fixtures. No real LangTracer data or paid provider calls are
required for parity tests.

## Milestone 4 Preserve advanced analysis and governed evidence

- Implement population freezing/draws and backend-specific snapshot provenance;
  analysis studies, stopping/deadlines, taxonomy, criterion promotion, and
  measurement projections.
- Implement independent/blind review, task histories, alignment, adjudication,
  imported truth, protected sealed intake, and dataset truth/exposure records.
- Implement binary calibration jobs, leases, attempts, private ledgers,
  immutable aggregate artifacts, admissibility/revocation, evaluator lifecycle,
  and exact execution authorization.
- Port database checks for project ownership, immutable records, event chains,
  complete bundles, digest correctness, and permitted erasure. Preserve the
  distinction between production feedback and governed evidence.
- Test Unicode ordering, JSON numbers, timestamp precision, raw byte retention,
  and content digests against shared golden vectors. Persisted historical
  artifacts must not be reconstructed differently by the SQLite path.

Completion: every specialist repository and invariant inventory item has
positive and negative coverage. Races cannot bypass sealed/nonsealed overlap
rules, independent review, revocation, or activation eligibility. Invalid direct
writes are rejected to the documented enforcement boundary. Any necessary
contract evolution has explicit compatibility tests.

## Milestone 5 Ship the two installation templates

- Add the SQLite template with persistent storage and no PostgreSQL service.
  Preserve the existing PostgreSQL distribution and Coolify behavior; add an
  equivalent SQLite deployment recipe where supported.
- Automate backend selection, database initialization/migrations, secrets
  provisioning appropriate to the installer, and first-account startup.
- Add readiness checks for initialized storage and job execution, graceful
  shutdown, and useful diagnostics for permission errors, disk exhaustion,
  database contention, incompatible schemas, and wrong deployment configuration.
- Implement/document consistent SQLite backups and tested restores, including
  WAL handling. Preserve the auth/encryption secret in a separate recovery
  record. Copying an active main database file alone is not a backup strategy.
- Exercise container replacement, application upgrade, repeat startup, and
  restoration into a disposable installation. Document when rollback requires
  restoring a backup rather than running an older image against a newer schema.
- Check the separately maintained `trustctl` installer if it is part of the
  supported installation path; scope any changes explicitly to template choice
  and the correct storage lifecycle. Do not assume this repo owns that code.

Completion: a new operator can launch either template, create an account,
connect a harness, run an evaluation, restart, and recover their installation
using the written instructions. The SQLite path runs with PostgreSQL absent.

## Milestone 6 Qualify parity and release readiness

Run meaningful tests throughout implementation; this milestone consolidates
coverage and operational checks rather than postponing them until the end.

- Parameterize shared behavioral tests over both backends. Retain backend SQL,
  migration, trigger, and locking tests. Do not count skipped database tests as
  passing parity.
- Add SQLite to CI and release smoke tests. Keep PostgreSQL coverage and
  repository-boundary checks; extend boundary tooling where necessary rather
  than weakening it to accommodate the new backend.
- Inject failures before/after job creation, claiming, provider dispatch,
  result persistence, receipt minting, and acknowledgement. Exercise concurrent
  duplicate submissions, lease loss, restarts, and rollback.
- Benchmark realistic synthetic imports and overlapping evaluation, review,
  analysis, and retention workloads. Measure event-loop responsiveness,
  contention, query latency, job progress, and WAL/disk growth. Publish measured
  operating guidance instead of an invented user-count limit.
- Run appropriate focused suites, full tests with explicit database coverage,
  typecheck, build, migration/restore tests, shared-contract guards, and release
  packaging checks. Reconfirm external evidence consumers where contracts change.
- Follow the repository's independent audit requirement for implementation
  batches. Review the exact diff, resolve findings, and retain reviewable
  checkpoints. Use `git diff --check` and preserve unrelated work.

Completion: the parity checklist is complete, both deployment smoke tests pass,
backups restore, existing PostgreSQL evidence is preserved, and remaining
limitations are deployment limits rather than silently missing product features.
Publishing or deploying to an existing installation is a separate action from
finishing implementation.

## Effort and decisions

Original ASSUMPTION (superseded by the Milestone 0 checkpoint's 55–85 days):
the audit's planning allowance was 50–80 engineer-days, approximately
10–16 engineer-weeks, for current-feature parity including testing and packaging.
This is not a delivery commitment or a prediction of autonomous-agent speed.
The first difficult-case milestone was estimated at 4–6 engineer-days and is
included in that allowance. Re-estimate after it; automatic installation alone
does not remove the database-porting work.

Resolve these choices early without reopening the agreed two-template scope:

| Choice | Recommended direction to validate |
| --- | --- |
| SQLite driver and runtime | Start from the successful Node built-in driver experiment; pin a tested runtime and verify packaging/backup behavior |
| Connection and transaction ownership | Short controlled transactions; prevent async request interleaving; keep network work outside them |
| Queue implementation | Durable SQLite execution implementing Rubrist's required behavior, with no additional database dependency |
| Deferred completeness enforcement | Prototype equivalent schema/transaction enforcement before broad SQL translation |
| Snapshot provenance | Explicit backend-aware semantics with appropriate contract compatibility |
| Startup compatibility | Templates select explicitly; existing PostgreSQL configuration remains valid; demo is deliberate |

The user has already agreed to the deployment direction. Routine implementation
choices within it do not need the deployment question asked again. Any proposal
to weaken evidence guarantees, reset retained data, or materially change a
public contract needs a concrete explanation and the applicable repository
decision process.

## Suggested prompt for the implementation session

```text
Implement the Rubrist SQLite deployment plan in:
/Users/makina/ai-trust/coeval/docs/sqlite-deployment-plan.md

The agreed goal is two fixed installation templates for the same application:
SQLite or PostgreSQL. The chosen template configures all persistent storage,
Better Auth, and background jobs. Each installation uses one database only.
SQLite initially supports one application instance on one host with durable
local storage, while retaining the currently implemented product features.

Read AGENTS.md and the required product/architecture documents, inspect the
current checkout and working tree, then work through the milestones in order.
Begin with the hard integrity, snapshot-provenance, and job-recovery cases.
Reassess the estimates after those prototypes. Preserve existing PostgreSQL
data, migration history, evidence guarantees, and unrelated local work. Keep
the database choice out of the product UI and do not add database conversion
or Cloudflare D1 to the scope.

Use synthetic fixtures; the LangTracer data work remains paused. Follow the
repository's validation and independent implementation-review requirements.
Update the plan with completed work, test evidence, and any remaining blockers
so the next session can continue from a concrete checkpoint. Do not publish a
release or deploy to an existing installation as part of implementation.
```

## References

- [n8n database selection](https://github.com/n8n-io/n8n-docs/blob/main/docs/deploy/host-n8n/configure-n8n/choose-n8ns-database.md): inspiration for installation-time selection; it does not establish Rubrist compatibility.
- [Better Auth SQLite](https://better-auth.com/docs/adapters/sqlite): upstream driver support; the installed-version experiment is described separately above.
- [SQLite isolation](https://sqlite.org/isolation.html), [WAL](https://sqlite.org/wal.html), [foreign keys](https://sqlite.org/foreignkeys.html), and [triggers](https://sqlite.org/lang_createtrigger.html): concurrency and integrity constraints to verify during implementation.
- [SQLite backup API](https://sqlite.org/backup.html): consistent backup foundations.

Web references were checked on 2026-10-04. Recheck version-sensitive details
against the runtime and dependencies selected by the implementation session.
