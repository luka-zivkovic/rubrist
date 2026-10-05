# SQLite Milestone 0: design and executable feasibility checkpoint

Status: CURRENT isolated prototypes; no persistent SQLite application runtime.
Date: 2026-10-05. Source baseline: `8cabae2ac7a4c70e5812cd85b35b5cfc7c678311`.

## Authority and scope

TARGET: the user authorized the two-template deployment in
[the handoff](../sqlite-deployment-plan.md) and requested implementation starting
with Milestone 0. Existing accepted product/evidence ADRs remain authoritative.
This checkpoint changes no application startup, PostgreSQL migration, evidence
schema, UI, provider call or deployment. All data is disposable synthetic data.

CURRENT: work began on `main` at the handoff baseline with no tracked diff.
The plan, `.impeccable/`, `site/`, and four `brag-output*` directories were
untracked. Work is isolated on branch `sqlite-milestone-0`; unrelated files
remain untouched. The provided plan is tracked as this implementation handoff,
not treated as authority for unrelated product decisions.

## Deployment architecture

TARGET: each installation selects a complete backend bundle exactly once:
main and specialist repositories, account/project administration, Better Auth
adapter, capability/resolution stores, migrations, queues, pollers and shutdown.
Routes consume explicit runtime mode and services. They cannot infer permission,
real-provider behavior or feature availability from the existence of a PG pool.
Main repository slices that instantiate specialists must also use the bundle.
The existing port and caller-owned transaction boundaries remain intact.

ASSUMPTION for Milestone 1 configuration (not implemented):

| Configuration | Result |
| --- | --- |
| `RUBRIST_STORAGE=postgres` plus `DATABASE_URL` | Persistent PostgreSQL bundle |
| No selector, valid nonempty `DATABASE_URL` | Existing PostgreSQL compatibility |
| `RUBRIST_STORAGE=sqlite` plus absolute `RUBRIST_SQLITE_PATH`, no `DATABASE_URL` | Persistent SQLite bundle |
| `RUBRIST_STORAGE=demo`, no persistent settings | Deliberate unauthenticated demo |
| No selector or persistent settings, source development only | Preserve documented development demo; production startup must require explicit selection |
| Mixed backend settings, empty supplied URL, unknown selector, missing path/secret, failed storage | Fail closed; never fall back |

Both persistent bundles require `BETTER_AUTH_SECRET`; provider/integration
credential encryption remains tied to it. Separate SQLite migration history
must be ordered, checksummed and serialized under `BEGIN IMMEDIATE`. Retain all
four PG migration hashes; never rewrite applied history under ADR-0011's hosted
review exception. Milestone 1 must prove Better Auth transaction ownership and
first-owner recovery against disk, not extrapolate from the prior memory test.

CURRENT prototype runtime: Node **24.15.0**, built-in `node:sqlite`, SQLite
**3.51.3**, macOS arm64. No new package dependency or global runtime change.
The existing container uses `node:24-slim`; Linux amd64/arm64 packaging and a
release image digest remain Milestone 1/5 qualification work. This is a tested
prototype version, not a claim that its SQLite driver API is stable forever.

ASSUMPTION: production uses one dedicated database worker owning the domain
connection and whole synchronous transaction commands. The public executor
accepts named commands and data, never arbitrary async callbacks. Better Auth
can use a separately owned connection to the **same file** if its adapter
transaction boundaries are verified. Database work in a worker keeps synchronous
queries/busy waits off the HTTP event loop. Never move network calls inside a
write transaction. Read-only connections use bounded read transactions; long
reads can retain WAL pages. Benchmark before choosing read-pool size.

CURRENT prototype opens independent file connections with foreign keys ON,
recursive triggers ON, WAL, synchronous FULL and bounded 50 ms busy timeout.
It checks foreign keys and rejects nested/async transaction callbacks. It is
an internal test helper with a raw connection for adversarial tests, not the
production executor. Returned promises are rejected but arbitrary closures can
still schedule later work; do not expose this helper as a production API.
Production startup must verify every setting on every connection. Busy retries
must restart a whole safe command and retain its idempotency key.

## Database enforcement and invariant inventory

CURRENT [machine-readable inventory](invariant-inventory.json) covers all
**206 function definitions (205 distinct names), 182 triggers, 19 deferred
triggers and 105 tables** in the four application migrations. The extra
definition is the authorship migration's replacement lifecycle-request digest.
Each definition has source location/hash, business purpose, rejection messages,
SQL-function dependencies, proposed strategy, and distinct positive/negative
validation IDs. Each trigger retains its own table-level validation ID even
when it shares a function. Source coverage is executable and detects drift.

ASSUMPTION: per-symbol strategies are a porting backlog, not 388 implemented
SQLite invariants. Every underlying SQL predicate (including predicates sharing
one error message), erasure exception and dependency still needs translation
and a behavioral test in its owning milestone. Table CHECKs, unique indexes,
foreign keys, PG extensions, queue-owned schema and query plans also need port
coverage; function/trigger enumeration does not replace that work.

CURRENT prototype mechanisms:

- Immutable bundles use a non-null reciprocal deferred FK to a finalization
  record. Missing finalization fails COMMIT, even after releasing an inner
  savepoint. An immediate finalization trigger verifies exact member count;
  member triggers enforce bounded unique positions, tenant identity and exact
  artifact content. Finalization freezes the member set. UPDATE, DELETE and
  REPLACE cannot rewrite history; explicit tenant erasure can cascade.
- Mutable streams require a new validation record for **each command token**.
  Earlier validation cannot satisfy later events; appending after that
  command's validation fails. This is the mechanism needed for deferred
  lifecycle-head checks, which a one-time bundle finalizer cannot replace.
- A private per-command token supports the `xmin`-based previously-committed
  promotion barrier: a handoff in the creating command fails, while a later
  connection/command succeeds. The token is a command identity, not a database
  transaction ID or public snapshot identifier. INSERT triggers validate it;
  an ephemeral token must not be a CHECK evaluated during integrity scans.
- Exact artifact bytes are SQLite BLOBs. A registered deterministic SHA-256
  function is invoked by a database CHECK; a forged digest is rejected through
  direct SQL. No decode/re-encode on reads. Full contract canonicalization,
  unsigned digests and byte-to-index correspondence remain domain-port work.

TARGET enforcement boundary: managed connections with required SQL functions,
foreign keys and recursive triggers enabled; database triggers reject invalid
DML even when repository validation is bypassed. A plain connection missing
required functions fails closed for affected writes. File owners or code that
can change schema, disable constraints or replace SQL functions are outside this
boundary, just as a PG administrator can replace triggers. Production should
restrict schema/PRAGMA operations on runtime handles with an authorizer and use
separate migration ownership. Pure canonicalization UDFs may be shared; a
repository-only validator cannot substitute for a promised database guard.

ASSUMPTION: production-deletion session settings become private scoped executor
capabilities checked by SQL functions, with mandatory audit evidence in the same
transaction. Identity-overlap and revocation locks become short write
transactions plus database constraints; no weaker sealed/nonsealed boundary.
These are explicit unimplemented cases, not claims established by the bundle test.

## Snapshot provenance and compatibility

CURRENT: `AnalysisPopulationSchema` is a strict public DTO requiring
`snapshotXid8`. PG records actual `pg_current_snapshot()` text and database
transaction time; `guard_analysis_population_row` verifies both and requires
repeatable-read isolation. The DTO has no independent response version today.
Readers include the shared Zod schema, PG row mapper and API response parsers;
analysis population API/model tests contain PG-shaped fixtures. Browser analysis
views receive this DTO even though they do not render the snapshot identifier.
No occurrence of this field was found in the receipt/calibration/suite contracts.

CURRENT: `apps/api/src/lib/analysis-population.ts` computes frame, member,
content and draw digests without `snapshotXid8` or `snapshotTakenAt`. Existing
stored artifacts must still be returned unchanged. Adding provenance to a
future digest basis would require a new basis and new identities; replacing a
DTO field does not authorize rewriting any stored bytes.

ASSUMPTION, proposed in [ADR-0016](../decisions/0016-sqlite-deployment-and-provenance.md):
introduce an explicitly versioned Analyze response with a strict discriminated
`snapshot` object, and retain existing PostgreSQL response parsing:

```json
{"kind":"postgres-repeatable-read/v1","snapshotXid8":"100:100:","takenAt":"2026-10-05T10:00:00.000000Z"}
```

```json
{"kind":"sqlite-serialized-freeze/v1","takenAt":"2026-10-05T10:00:00.000000Z"}
```

The proposed SQLite shape deliberately has **no snapshot identifier**. A
`BEGIN IMMEDIATE` freeze holds a consistent database view, excludes concurrent
writers, and persists exact membership/exclusion payloads and digests before
commit. An immutable snapshot row created inside the controlled command records
server time; triggers compare it to the private command time and enforce the
existing 60-second window lag. An opaque command token is stored privately only
where required for commit barriers. SQLite time initially has millisecond
precision padded to six fractional digits, honestly documenting that precision;
precision changes cannot alter old stored timestamps.

TARGET compatibility tests before Milestone 4 runtime: old PG DTO parses with
unchanged bytes; old readers reject the explicitly versioned new response;
new readers handle both PG and SQLite kinds and reject unknown kinds/fields;
no SQLite response passes the old PG-only schema; unchanged member sets give
identical existing content/frame digest inputs; window cutoffs, active writer
interleaving, restart, and direct forged time/context fail safely. Release the
new response through an explicit API version/negotiation boundary, not by
silently widening the old schema. No receipt or calibration contract change is
needed for this provenance design. The exact API version/negotiation choice
and ADR approval remain gates before wiring it into Analyze.

CURRENT executable evidence: the WAL test keeps one reader's view stable across
another connection's commit; a concurrent writer cannot enter while the freeze
writer holds `BEGIN IMMEDIATE`. This establishes the SQLite isolation mechanism,
not a complete application population-freeze implementation.

## Execution ownership across external calls

CURRENT prototype is one logical attempt store, not a queue implementation.
`claim` atomically assigns owner, incrementing epoch and database-time expiry.
`start` checks all three while claimed and commits the one-call marker. Only
then may the worker dispatch. `finish` checks owner, epoch, state and unexpired
lease in its update predicate. Network work holds no database transaction.

| Interruption | Recovery |
| --- | --- |
| Before claim commits | Claim is available; uncommitted writes roll back |
| After claim, before durable start | Expired claim may be replaced; old epoch cannot dispatch |
| After durable start, before actual dispatch | Permanent `outcome_unknown`; conservative one-call accounting |
| After dispatch, before result commits | Permanent `outcome_unknown`; never call again for this logical attempt |
| Result arrives after expiry/replacement | Reject result; it cannot overwrite terminal uncertainty |
| After terminal completion | Duplicate delivery cannot claim, start or complete again |

CURRENT SIGKILL tests exercise uncommitted work, committed claims and committed
start markers, then reopen the same file. Independent connections demonstrate
fenced replacement and unrelated writes while two synthetic calls are in flight.
No provider was called. A stopped process can still resume in the tiny gap
between durable start and sending bytes; a local lease cannot retract an
external request. The design prevents replacement dispatch and stale persistence,
not exactly-once provider execution. Graceful shutdown must stop dispatch,
cancel where possible and drain commands before closing storage.

ASSUMPTION: apply the same ownership to regression execution per evaluator/run
scope, leaving ordinary independent evaluations concurrent. Keep outbox records
atomic with domain creation, stable queue IDs, backoff, expiry and terminal
state lookup. Queue redelivery is independent of domain permission to dispatch.
Lease renewal, full queue behavior, counters, terminal receipt minting and
calibration private-ledger recovery remain Milestones 2–4 work.

## Reproduction, review and effort

Use Node 24.15.0 (installed locally under nvm), from repository root:

```sh
node --test tools/sqlite-prototype.test.mjs tools/sqlite-inventory.test.mjs
node tools/sqlite-inventory.mjs
```

The root `pnpm test` picks up these tests through `tools/*.test.mjs`; no SQLite
test is conditional on a database environment. Tests create and remove temporary
files and kill only child processes they launched. They access no configured DB.

CURRENT: 16 prototype tests plus three source-inventory tests pass. The SQLite
backup API restores committed BLOBs and passes FK/integrity checks. This is a
consistent backup mechanism check, not a power-loss test or operator restore
qualification. Review and broader validation results are recorded in
[milestone-0-validation.md](milestone-0-validation.md).

ASSUMPTION updated allowance: **55–85 engineer-days total**, including 4–6 for
Milestone 0; **49–81 remaining** after that allowance. The extra 5 days over the
handoff covers per-command deferred validation, previously-committed barriers,
SQL UDF verification and versioned Analyze reader migration. Mechanisms appear
viable; no reduction in the original parity estimate is justified by these
small tests. These are planning allowances, not elapsed agent-time predictions.

Before calling later milestones complete: finish per-invariant direct-write
coverage, authenticated persistent startup, actual worker serialization, Linux
packaging, restore/upgrade qualification, workloads and all scheduled jobs.

## Checked upstream references

Checked 2026-10-05: [foreign keys and deferred commit checks](https://sqlite.org/foreignkeys.html),
[SQLite isolation](https://sqlite.org/isolation.html),
[trigger behavior](https://sqlite.org/lang_createtrigger.html), and
[backup API](https://sqlite.org/backup.html). Driver behavior was checked on the
installed Node 24.15.0 runtime; broader platform support remains unverified.
