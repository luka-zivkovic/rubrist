# SQLite Milestone 4 progress

CURRENT: implementation in progress; the milestone is not complete and no M4 PR
is ready yet. Follow the same independent audit, CI, Copilot and merge workflow
as prior milestones. Deployment is not part of this work.

## Accepted direction

TARGET: accepted ADR-0016 permits exact BLOB evidence and an honest SQLite
Analyze provenance variant while preserving PostgreSQL responses and all
existing evidence digest bases. Claude Code's agent-bridge architecture review
found no new ADR gate for porting the currently implemented specialist domains.
The unrelated comparative-execution decision and proposed help-layer ADR remain
out of scope.

## Foundation checkpoint

CURRENT: each synchronous managed write command owns a private random token,
its write transaction, and a persisted non-decreasing millisecond timestamp.
The clock is sampled after `BEGIN IMMEDIATE`, initialized from retained ingestion
and exposure timestamps, and rolled back with failed commands. Equal timestamps
are permitted; this is a conservative ordering mechanism, not a claim that the
host wall clock is always accurate. Case ingestion and exposure inserts require
the command's UTC ISO timestamp. Plain connections cannot perform these guarded
writes without the private context functions.

The authorizer rejects transaction and savepoint escapes, including cached
statements. Scoped handles reject use after completion or implicit rollback.
Existing ingestion and exposure paths now use the same command time; golden
revision creation reads it instead of sampling a separate clock.

The strict Analyze population union leaves PostgreSQL's `snapshotXid8`,
`snapshotTakenAt`, field order and response values unchanged. SQLite instead
uses `snapshotProvenance: "sqlite-serialized-freeze/v1"`, with server time at
millisecond precision and no xid. Both/neither and unknown variants fail closed.
CURRENT consumer search finds API self-validation, the web API parser, and the
Analyze page (which reads the common `snapshotTakenAt`). Routes require a user
session and are not exposed to API-key callers. No other consumers are present
in this repository; this does not claim knowledge of external user scripts.

Shared canonical JSON/digest functions run as deterministic SQLite UDFs. UTF-16
ordering uses big-endian code-unit BLOB keys, matching JavaScript and PostgreSQL.
These functions are intended for triggers, leaving maintenance reads and
integrity checks independent of application UDF registration.

## Validation

CURRENT: independent foundation/provenance audit approved with 35/35 focused
context, real-table, historical-upgrade, shared-contract and web tests. Added
PostgreSQL/SQLite golden-vector and SQL Unicode-ordering tests passed together
with command context tests (10/10, PostgreSQL enabled). The full SQLite suite
initially passed 124/125; the historical fixture was then adapted to supply a
TEMP clock while generating old-schema data, removed before migration. The
focused rerun passed. After rebasing onto the M2 membership fix and updated M3,
the full SQLite suite passed 126/126 tests in 21 files. Migration 0024 adds the
command clock after the preserved M2/M3 migration history.

## Remaining work

TARGET: populations/draws; studies/deadlines/taxonomy; governed review, imported
truth and sealed intake; promotion and measurement; calibration leases,
attempts, artifacts and revocation; lifecycle activation, replacement,
retirement and execution authorization. Each domain needs its full database
invariant port, typed repository wiring and positive/negative coverage.

The foundation does not implement those specialist repositories or establish
complete coverage of the 54 digest functions / 388 inventory entries. Remove a
staging guard only alongside its complete replacement. Commit audited domain
chunks within the single Milestone 4 PR requested by the user.

## Follow-up foundation and validator design

CURRENT: migration 0025 seeds durable sealed/nonsealed input ownership from
retained case identities and dataset revision items, then claims automatically
on new evidence. Conflicting classes fail inside the same transaction; claims
survive traffic retention and can disappear only with project erasure. Tests
cover concurrent imports, direct case/revision claims, rollback and migration.

CURRENT: raw SQL canonicalization preserves exact numeric literals using the
Node 24 JSON reviver source; it does not round them through JavaScript numbers.
All literals, including overwritten duplicate values, are validated. Tests
compare PostgreSQL on long decimals, integers above binary64's exact range,
very small/large exponents, trailing zeros, invalid strings/numeric bounds and
sub-microsecond timestamp rounding. The application JSON helpers are unchanged.

TARGET engineering design, independently consulted through agent-bridge on
2026-10-06: population/draw guards use SQL joins, exact set comparisons and pure
canonical digest UDFs. Finalizers must also prohibit relevant source changes
later in the same command; an immediate finalizer alone does not implement a
commit-time check. Population finalization works on compact IDs/digests.

For payload-heavy study-open frame re-derivation, a versioned read-only validator
UDF is permitted within ADR-0016. It must be called only by a trigger, require
managed context, forbid reentry and mutations, prepare queries inside a
read-only authorizer window, stream with iterator cleanup, keep no caches, and
return a verdict checked by RAISE(ABORT). It must never change connection state
or appear in a CHECK, index, generated expression or view. These are conditions
for the future implementation, not a claim that such a validator exists yet.

Claude's isolated Node 24.15 / SQLite 3.51.3 probes found that one SQL statement
retains UDF arguments until completion: hashing 100,000 synthetic 2 KB payloads
used roughly 405–645 MB RSS, while a streaming reader used roughly 69–73 MB.
These consultation probes motivate bounded streaming; they are not the
Milestone 6 application benchmark or operating guidance.

CURRENT follow-up validation: independent audit approved 14/14 focused tests
with PostgreSQL enabled. All 128 SQLite tests pass in 22 files; typecheck and
shared-contract guards pass. The contract fixtures add only the two explicitly
named provenance variants approved by ADR-0016.

## Population database checkpoint

CURRENT: migration 0026 ports population, member, exclusion, draw, selection and
request persistence. Reciprocal deferred finalizers require complete ordered
frames, exact source identities and revision references, original digest bases
and a complete deterministic draw. Source changes are forbidden throughout the
creating command; committed ordinary retention still preserves frozen evidence.
The analysis revision remains barred from ordinary evaluation.

Population source projection and revision-bound payload equality preserve exact
SQL numeric values, including binary64-colliding integers. Startup registers
command functions eagerly, and project erasure owns a managed command even as
the first domain write after restart. Older direct-mutation test fixtures now
use the managed command path. Independent audit approved the migration and
precision changes; 30 population tests pass, and all 159 SQLite tests pass in
23 files. Repository/API wiring is still in progress; these checks do not claim
that the full population feature or Milestone 4 is complete.

CURRENT: all eight population repository methods now run through the SQLite
worker and are wired into the production API entry point. Creation serializes
ownership checks, exact request replay, frame reuse and atomic bundle writes;
payloads are loaded one at a time while only compact digests/identities are
retained. Metadata pages preserve deterministic pagination, and selected-content
reads record an exact deduplicated exposure before releasing retained content.
Typed domain errors survive RPC. Invalid retained payloads return conflict
responses rather than unhandled validation errors. Independent repository audit
approved the implementation and authenticated HTTP fixes; all 32 population
tests and API typecheck pass. Other specialist domains remain incomplete.
