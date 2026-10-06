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

## Nonsealed governed draft bundles

CURRENT: migration 0043 and the internal draft builder freeze server selection,
serve order, exact review membership and the complete reviewer assignment set
in one command. Reciprocal deferred keys require finalization before commit;
finalization checks the draw digest and every assignment, streams exact blind
views through a scoped read-only size validator, and prohibits later appends.
Sampling decimals remain TEXT JSON numeric tokens to preserve digest precision.

CURRENT: the blind-view artifact builder and its pure support functions are
shared unchanged with PostgreSQL. Eighty-four governed SQLite/shared/PostgreSQL
tests passed, plus PostgreSQL numeric interoperability vectors. Independent
audit approved the slice after correcting offset-aware time-window ordering;
all ten final draft tests and API typechecking pass. The broader SQLite suite
passed 334 tests immediately before this draft slice. Other governed source
kinds and public repository wiring remain unfinished.

## Exact blind views and initial governed streams

CURRENT: migration 0044 adds immutable, versioned batch and task streams with
open/abandon and view/defer/resume transitions. Exact reviewer-visible bytes
are retained as BLOB, validated against the frozen task projection, and encoded
as base64 only for the unchanged event digest and wire representation. Replays
return the stored artifact; live membership is checked on every read.

CURRENT: independent audit approved 17 focused tests. The final SQLite and
PostgreSQL regression run passed 25 tests, and API typechecking passes. Tests
cover stale versions, forged bytes with recomputed hashes, pinned reviewer
identity, abandonment, revoked membership, plain SQLite backup and project
erasure. Label, barrier, sealed and public repository paths remain unfinished.

## Independent labels and the labeling barrier

CURRENT: migrations 0045–0046 bind each immutable label to its same-command
submission event, preserve withdrawn-attempt lineage, and expose current active
labels through a SQL projection. Labeling closure atomically expires pending
tasks at the fixed stop while retaining deferred tasks. Resolution distinguishes
complete single-rater/unanimous truth, coverage gaps and unresolved conflicts.

CURRENT: independent audit approved 24 focused label, view and barrier tests
after two corrections: dynamic validator registration on fresh connections, and
using the database's full-precision stop comparison in command preflight.
Tests include two-connection continuation, orphan rejection, failed-event and
failed-closure rollback, replacement/replay, microsecond boundaries and project
erasure. API typechecking passes. Alignment, adjudication, sealed paths, truth
freeze and public repository wiring remain unfinished.

## Post-barrier alignment evidence

CURRENT: migration 0047 freezes each alignment event's complete visible label
set in the same statement. It enforces live owner/assigned-reviewer access,
stream versions and digests, immutable instruction-successor proposals and
closure before adjudication. Snapshot failure rolls back the entire event.
Independent audit approved 25 alignment/barrier/label tests; API typechecking
passes. Adjudication chains, sealed paths and truth freeze remain unfinished.

## Adjudication chains

CURRENT: migration 0048 adds immutable adjudication chains, exact considered-
label snapshots, live-owner/rater separation and compare-and-swap corrections.
Resolution uses the current adjudication head without changing original labels;
unresolvable decisions produce incomplete batches. Independent audit approved
22 adjudication/alignment/barrier tests, including snapshot rollback, forged
successors, peer replay and erasure. API typechecking passes. Truth-materialization
and sealed-separation guards must land before enabling freeze or sealed access.

## Authoritative truth links and nonsealed freeze

CURRENT: migrations 0049–0050 require exact native/imported truth links, complete
label snapshots and atomic revision finalization. Native freeze binds the exact
resolved payload and adjudication head, creation exposure and representative
scope. Imported self-attested/unverified classes remain distinct. Materialized
truth blocks later adjudication mutation. Batch events now retain private command
tokens, preventing equal server timestamps from standing in for command identity.

CURRENT: Claude Code confirmed the hardening fits ADR-0016/0008 without a new
ADR. Its consultation caught normalization in the older dataset item validator.
A forward trigger uses v2: validate one exact payload shape, hash original parsed
values, and require an authoritative truth link for every metadata-free item.
The original validator and historical migrations remain unchanged. Public read
projections retain their PostgreSQL-compatible metadata defaults.

CURRENT: independent audit approved 22 focused tests after the imported-payload
shape correction. API typechecking passes. The broader SQLite plus actual
PostgreSQL governed-review run exercised 418 tests in 50 files: 417 passed and
one retained an old error-message assertion; all ten freeze tests passed after
that assertion was corrected. Tests cover rollback at each freeze step, native
and imported payload forgery, numeric round trips, same-time command tokens,
adjudicated truth, manual-sampling limits, peer continuation and plain integrity
checks. Sealed intake, capability separation and sealed freeze remain unfinished.

## Sealed intake frames

CURRENT: migration 0051 freezes sealed intake populations and their complete
ordered frames atomically, checks retained payload/input identity, and reserves
durable sealed input claims. Cross-class reuse and unrelated sealed reuse fail;
protected successors must bind exact unexposed predecessor items in the same
lineage. Receipt responses contain no item payloads or internal item IDs.
Independent audit approved eight focused tests and API typechecking passes.
Positive protected-successor execution still requires the sealed freeze port.
Sealed batch access remains staged pending live capability separation.

CURRENT 0052: immutable system-derived separation checks now derive criterion,
instruction and evaluator lineage authorship plus durable development exposure.
The scoped database validator rederives the full result and evidence; SQL also
checks tenant bindings, digest bases, stream sequencing, bounds and immutability.
Changed facts append a new snapshot even when the enclosing command key repeats.
Calibration-specific and independently verified checks remain staged. Twelve
focused tests pass (including forged eligibility, exposure changes and unknown
historical authorship), as do four specialist module-boundary tests and the API
typecheck. Independent audit reran all twelve and approved without findings.
Sealed access and the complete repository remain pending.

CURRENT 0053: sealed drafts bind the finalized protected population's exact
frame digest, collection provenance, time window and custodian. Shared draft
construction preserves nonsealed behavior and accepts client-item aliases for
sealed directed selection. Each sealed item receives at least two distinct
reviewers, none the custodian. Sealed execution remains staged pending live
separation gates. Independent audit approved 17/17 sealed/nonsealed draft tests;
API typecheck passes. Enforcement boundary: like the current PostgreSQL path,
SQL checks immutable draw consistency and completeness; the trusted command
executes sampling and serve-order algorithms. SQL does not independently
reproduce random selection from the seed.

CURRENT 0054: sealed opening checks the custodian and every reviewer. Protected
views, task actions, alignment and adjudication rederive live separation before
returning historical payloads or performing writes, including idempotent replay.
Scoped SQL guards require the latest eligible record and current facts within
the serialized command. Failed capability evidence commits without the protected
operation; typed domain errors reach the caller. Independent audit approved
41/41 relevant tests; API typecheck passes. Sealed freeze remains staged.

CURRENT 0055: sealed freeze now commits the exact protected item payloads,
resolved labels, authoritative truth links, revision finalization and frozen
batch event in one command. Every content-exposed reviewer/custodian/adjudication
reader receives a live separation check. Successors must directly continue the
protected sealed predecessor; development exposure and competing sealed children
block the write. Independent audit approved 21/21 sealed/nonsealed freeze and
truth-link tests; API typecheck passes. Tests include competing batches over one
successor intake, exposure after intake, orphan rejection and atomic rollback.

CURRENT governed read projections: batch/task lists and summaries preserve
PostgreSQL field shapes, ordering, hidden pre-barrier progress and hidden sealed
outcomes. Detailed post-barrier reads check current membership, assignment or
owner access, and sealed separation in the same command that loads the payload.
Independent audit approved all three focused projection/authorization tests;
API typecheck passes. Runtime composition is the next slice.

CURRENT governed runtime composition: all 16 repository methods now cross the
serialized SQLite worker, and startup injects the repository into the existing
session-only HTTP module. Promotion-handoff batch creation remains explicitly
staged until the promotion port lands. Typed governed errors preserve safe
public fields and class identity across RPC. Independent audit found and
verified a corrected sealed-successor error mapping; nine runtime/read/transport
tests pass, including concurrent replay, restart byte identity, HTTP conflicts,
and exposed-predecessor `sealed_overlap`. API typecheck passes.

CURRENT consolidated governed qualification: 462/462 tests across 57 files pass,
including the full then-current SQLite suite and real PostgreSQL governed-review
coverage. This qualification predates the promotion slice below.

CURRENT 0056–0057: immutable analysis-code promotion now binds the exact closed
study, current taxonomy head, closure-active support/assignment evidence, one
new criterion definition, and complete development exposures in one serialized
command. A mandatory deferred finalization claim checks canonical support,
request, handoff and content digests. Trailing writes after finalization cannot
change the bundle. Native criteria cannot use the promotion namespace; analysis
promotion activities cannot evade their evidence namespace. Promoted evaluator
creation remains staged pending lifecycle completeness.

The governed handoff binds the full original analysis revision, including items
outside the promotion support set. It requires a promotion committed in an
earlier command, preserves blind projections, and completes the existing
review-to-truth workflow. All five promotion repository methods cross the
worker and are injected at startup; typed errors survive RPC. Claude Code's
ADR consultation found no additional founder decision needed. Independent audit
approved the implementation after an exposure-reference bypass was corrected.
47/47 focused tests and API typecheck pass; four post-finalizer tests additionally
assert the specific raw guard failures. Adjacent draft/freeze/transport coverage
also passed independent review. Shared promotion mapping/cursor helpers retain
PostgreSQL behavior, verified by 18 real-PG/API/model tests.

TARGET remaining M4: measurement, calibration/private ledger/admissibility,
evaluator lifecycle and execution authorization, complete invariant-inventory
mapping, and final cross-backend qualification. M4 is not complete yet.

CURRENT governed error parity: withdrawing an active label already exposed by
alignment or adjudication returns the existing revealed-label error after the
usual replay/CAS checks. Local and worker tests preserve class identity and
leave the label unchanged. Independent alignment/label tests pass 21/21.

CURRENT calibration preparation: shared pure aggregate, provider-policy,
attempt-accounting and artifact/run projection helpers were extracted without
changing any function body or PostgreSQL query. Independent review verified
29 declarations and 30/30 real PostgreSQL/contract/integration tests with mocked
providers. This does not yet enable SQLite calibration.

CURRENT calibration control checkpoint: migrations 0058–0059 retain queued run
identity, exact sealed truth and immutable suite-member pins, durable worker
claims, claim takeover, heartbeat, recovery and pre-authorization rejection.
Clock-sensitive reads and recheck timestamps use the serialized command clock.
SQLite suite members come from the exact retained manifest BLOB. Independent
review approved seven focused tests, including two-connection takeover,
backwards host time, stale claims, tenant boundaries, replay, direct-SQL
initialization guards and project erasure. It verified all 42 PostgreSQL pinned
identity columns remain immutable. These are internal controls: provider
dispatch, final-validation checks and terminal evidence are still staged; no
calibration HTTP/RPC surface is enabled yet.

CURRENT calibration authorization checkpoint: migration 0060 enables native
final-validation checks, a single active revision lease, exact governed attempt
seeding, durable provider-call starts and terminal attempt accounting. An
ineligible authorization commits its capability checks and rejected run before
returning the typed error. An interrupted started call is accounted as
`outcome_unknown`, never returned as fresh work. Deferred authorization claims
require the complete bundle and prevent additional attempts after finalization.
Development exposure is blocked while the lease is held. Snapshot semantics
are constructed by the application, with database byte-digest and ownership
checks matching PostgreSQL. Independent review approved 25 focused calibration
and governed-capability tests, including replay, competing evaluators, rollback,
restart and erasure; API typechecking passes. Terminal mint, public repository
wiring, lifecycle and measurement remain unfinished.

CURRENT calibration mint checkpoint: migration 0061 commits completion checks,
public artifact bytes, the private ledger, terminal run state and lease release
as one bundle. Its scoped read-only finalizer reconstructs public/private bytes
from retained run/attempt facts and authorization/completion metadata. Snapshot
semantic construction still follows the PostgreSQL application boundary.
Artifact lineage columns and completion event IDs must agree with public bytes.
Explicit revocations and later development exposure change current admissibility
without rewriting immutable evidence; there is no new revocation write API.
Independent review approved the bounded mint slice after correcting those two
metadata/reference checks. Five focused mint tests cover backup/restart, unknown
outcomes, complete rollback, current revocation and forged bytes with recomputed
digests. Runtime/public wiring and governed evaluator lifecycle remain pending.

CURRENT native calibration runtime: all seven control and thirteen execution
repository methods now use serialized SQLite RPC. The HTTP app receives only
the control facade; startup registers the existing calibration worker with its
separate execution facade, provider executor and binding recheck. Typed errors
retain their class and public code across the worker boundary. Independent
runtime tests pass 3/3 with mocked provider calls, concurrent replay, restart,
owner/member HTTP access, stored artifact bytes and recheck backoff. This does
not yet enable analysis-promoted evaluator versions: lifecycle and all consumer
authorization guards must land together before removing their staging guards.

CURRENT lifecycle preparation: twelve pure functions and their cursor interface
were extracted unchanged for shared use. Independent AST comparison verified
all prior declarations and unchanged PostgreSQL class/query bodies; 27 actual
PostgreSQL/API/model regressions pass. This extraction introduces no lifecycle
storage behavior.

CURRENT qualification checkpoint: 550 tests pass across 67 SQLite and real
PostgreSQL files, including analysis promotion, governed review, calibration,
and lifecycle shared models. A separate injected TypeSafe transport test
preserves the exact binary64 threshold and excludes private question text,
probabilities, request IDs and credentials from retained evidence.

CURRENT lifecycle storage: migration 0062 adds immutable lifecycle/event tables
and plain SQL head, admissibility and execution-context views. Independent
review approved both the storage and typed calibration tests (2/2); adjacent
storage/typed coverage passes 24/24 and API typechecking passes. Lifecycle
inserts remain staged until complete candidate bundles and all consumer guards
are implemented together. This checkpoint does not enable governed evaluators.
