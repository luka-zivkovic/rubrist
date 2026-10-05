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
the full SQLite suite passed 126/126 tests in 21 files. Migration 0026 adds the
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

CURRENT: migration 0027 seeds durable sealed/nonsealed input ownership from
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

For payload-heavy study-closure frame re-derivation, a versioned read-only validator
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

CURRENT: migration 0028 ports population, member, exclusion, draw, selection and
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

CURRENT: M4 migrations 0026–0028 follow M2 terminal metadata and M3 rebuild fixes. M4 filenames were advanced only in unpublished development history.

CURRENT: a versioned trigger-only validator facility now provides scoped,
read-only streaming queries under the command's existing authorizer. It rejects
mutations, reentry, expired readers/cursors and asynchronous verdicts; abandoned
iterators close before the guard returns. The first validator independently
recomputes retained population frames using PostgreSQL's whole-normalized-
payload digest basis and exact identity-count/source-binding rules. It returns
an assessment verdict checked by a trigger's RAISE(ABORT). Independent validator,
evaluation and population tests pass 52/52. Actual study-closure wiring and
same-command closure source guards are still pending.

CURRENT: migration 0029 adds permanent study/draw ownership and frozen selected
study items, with exact owner/subject, lineage and digest checks and reciprocal
complete-bundle finalization. The records survive ordinary retention and erase
only with their project. Independent draft-study audit approved 9/9 focused
checks; the complete population/draft test file passes 42/42. Study transitions,
observations, taxonomy and closures remain pending, so the study repository is
not yet enabled.

CURRENT: unpublished M4 migration names advance to 0026–0029 after the M2 correction-reason forward guard and unchanged M3 SQL.

CURRENT: migration 0030 adds append-only study open/abandon transitions with
exact CAS ancestry, owner binding, frozen stopping rules, canonical digests and
database command-time deadline enforcement. Independent audit approved 12/12
focused tests; combined population/context tests pass 58/58. Closure transitions
remain staged until their complete materialized evidence guards are installed.

CURRENT: migrations 0031–0032 preserve multi-label coding events, explicit
no-failure evidence, exact withdrawal/reopen targets, frozen payload anchors,
member/owner provenance and deadline cutoffs. Content views bind their exact
retained development exposure and closure participation. Independent audit
approved 20/20 focused checks; the full population/study file passes 74/74.
Post-closure views will be exercised with the forthcoming closure bundle.

CURRENT: migration 0033 adds complete immutable taxonomy revisions with exact
request-bound ordered entries, stable code identities, successor CAS, permanent
retirement and reciprocal deferred finalization. Independent audit found and
verified a fix for owner membership changing inside the code-creation command.
All 18 taxonomy tests pass. Combined population/study/taxonomy tests pass 93/93,
including positive member-authored coding, step anchors and member exposures.

CURRENT: migration 0034 adds immutable observation-assignment histories pinned
to the current finalized taxonomy head. Writes require an active observation,
exact actor role and predecessor, an active code for assignments, and an open
study before its deadline. Withdrawals preserve retired-code history. Independent
audit approved 12/12 focused tests; combined domain tests pass 105/105.

CURRENT: migrations 0035–0036 materialize immutable closure evidence with exact
historical coding/view/assignment projections, independent streamed frame and
SQL draw recomputation, representative-reason precedence and complete-bundle
finalization bound to the closing event. Same-command frame/coding mutations
are rejected; later retention and non-counting content views preserve history.
Deadline effective time and exact owner completion acknowledgment are retained.
Independent closure audit approved 22/22 tests and inspected scoped query plans;
API typecheck passes. The study repository is still not wired.

CURRENT: migration 0037 and deadline helpers persist exact overdue-study retries
with bounded exponential backoff, command-time comparisons and atomic clearing.
Independent audit approved 11/11 focused tests, including restart, due boundaries,
closed/foreign-study isolation and failed-closure rollback. API typecheck passes.
Study repository and scheduler wiring remain pending.

CURRENT: study/taxonomy read projections now share unchanged public artifact
mappers with PostgreSQL. Independent audit approved history, tenant scoping and
coverage semantics after correcting native SQLite bigint decoding. A focused
regression verifies the signed-bigint maximum; projection, shared model and API
checks pass. Public repository wiring remains incomplete.

CURRENT: the production closure builder independently derives frame/draw/item
artifacts and writes the complete database-verified bundle. Create/open/close/
complete/abandon commands preserve exact replay, current owner checks and
permanent draw ownership. Independent audit verified corrections for existing-
study conflict details and deadline failure retry after final-write rollback;
all 9 command/closure-builder tests pass. Full SQLite suite passes 282 tests in
29 files before the latest command regressions. Remaining item, taxonomy and
repository/runtime wiring is still incomplete.

CURRENT: study/taxonomy/assignment reads and the bounded deadline batch now
preserve tenant checks, exact-count keyset pages, historical coverage and durable
per-study failure isolation. The final read transaction rechecks a newly reached
deadline before returning projections. Independent read audit approved 4/4 tests,
including pagination across tied timestamps and healthy deadline continuation.

CURRENT: member coding and content-read commands now preserve exact replay,
current role checks and deadline-first behavior. Content returns only after its
exact exposure and deduplicated view commit. Migration 0038 adds PostgreSQL's
per-person/per-item and study-request uniqueness independently of command keys.
Independent audit approved; strengthened tests cover a valid-domain missing
anchor and late view failure rolling back its exposure (4/4 pass).

CURRENT: taxonomy creation/revision and observation assignment commands preserve
stable code history, owner/member roles, exact CAS and historical replay. The
independent audit verified typed assignment conflicts and rejection of unknown
existing codes before writes. All 5 focused taxonomy/assignment tests pass.

CURRENT: all 21 analysis-study repository methods are registered in the SQLite
worker and exposed to authenticated API routes. Startup runs the existing
bounded deadline closer; shutdown drains it before closing storage. Typed
study errors retain only public code and safe conflict details across RPC.
Independent wiring audit approved concurrency, restart, HTTP and shutdown
coverage. Qualification passed 326 SQLite/shared tests; the 12 PostgreSQL study
tests were run separately with PG_SMOKE_DATABASE_URL and all passed. This
completes the study port, not M4: governed review, promotion/measurement,
calibration and evaluator lifecycle remain incomplete.

## Governed review instructions

CURRENT: migration 0039 and typed instruction commands preserve project-scoped
criterion lineage, exact allowed labels and digest basis, byte limits,
immutability, replay, live owner checks and project-only erasure. PostgreSQL
and SQLite share the original 48-hex stable artifact identity helper. The
independent audit caught and verified the correction of an initial shorter
SQLite identity. Eight focused tests pass, including a fixed Unicode identity
and digest vector; API typechecking passes. The remaining governed repository
is not yet wired or complete.

## Imported human truth and governed timestamps

CURRENT: migration 0040 and typed create/list commands retain the existing
canonicalJson(parsed sourceArtifact) bytes in STRICT BLOB storage, with exact
source-byte, provenance and content digests. Importing complete caller claims
can produce only self-attested evidence; trusted verification remains unavailable.
The database enforces byte limits, classifications, digest binding, immutability
and project-only erasure. Repository checks use current owner membership.

CURRENT: the independent audit approved the port and 29 focused tests passed
with the disposable PostgreSQL oracle enabled. Additional independent JSONB
byte-size vectors matched PostgreSQL. Bounds count PostgreSQL JSON separator
spaces and retained numeric scale, without rounding precise SQL JSON numbers.

CURRENT: the governed timestamp helper emits PostgreSQL's UTC JSON form with
microsecond precision, including binary64 fractional parsing and ties-to-even
rounding. It validates calendar dates and offset limits, and fails closed if
normalization crosses its supported AD years 0001–9999. PostgreSQL's configured
session time zone remains unchanged; the helper's parity vectors explicitly use
UTC. This helper is distinct from Analyze's existing millisecond representation.

TARGET: the remaining governed review paths must retain exact blind-view bytes
as BLOB, deriving the unchanged canonical base64 digest/wire field from those
bytes. Claude Code's follow-up consultation confirmed this fits ADR-0016, as
does retaining the imported artifact's existing canonical byte format. No new
ADR decision was required. Backup custody documentation remains part of M5.

## Governed development authorship and subjects

CURRENT: migration 0041 atomically backfills recorded evaluator authorship using
retained version timestamps, PostgreSQL's IDs and its exact digest basis.
Unknown historical authorship remains unknown. New recorded versions append
immutable development evidence in their owning command. Legacy empty/NUL
identity values abort the migration; ordinary integrity checks need no UDFs.
The migration-only BLOB SHA-256 helper is not referenced by persisted schema.
Claude independently confirmed the fixed string-key canonical byte construction.

CURRENT: governed review now has its own subject helper with PostgreSQL's stable
48-hex identities. Existing subjects are reused, including identities originally
created by Analyze. Assignable-subject reads require live owner membership and
retain pseudonymous evidence after account deletion. The independent audit
approved this slice with 22 focused tests; API typechecking passes.

## Frozen nonsealed review items

CURRENT: migration 0042 and the internal materializer bind review items to an
exact same-project nonsealed source revision, source item and input identity.
Stored payloads must equal the safe projection of the immutable source;
metadata and forbidden reviewer-visible fields cannot be substituted. Exact
content digests, byte bounds, replay, immutability and project erasure are
covered. Sealed insertion still fails closed pending its complete population,
frame and protected-successor port. Independent audit approved all nine focused
tests, and API typechecking passes. No new public route is exposed yet.
