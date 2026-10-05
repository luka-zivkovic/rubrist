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
