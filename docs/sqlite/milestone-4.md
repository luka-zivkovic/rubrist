# SQLite specialist repositories and invariant qualification

CURRENT: Milestone 4 implements the existing analysis, governed-review,
calibration, evaluator-lifecycle and measurement repository contracts in the
SQLite worker. Installation packaging and release qualification remain M5–M6.
No installation has been deployed. See the [progress record](milestone-4-progress.md)
for the incremental independent audits and [implementation map](invariant-port-map.json)
for source and test navigation.

## Authority and compatibility

TARGET: accepted ADR-0016 authorizes the SQLite storage variant. Existing
ADRs for independent truth, calibration and lifecycle remain authoritative.
Claude Code consultations through agent-bridge confirmed that these ports do
not require a new product or ADR decision. Comparative execution, proposed
ADR-0015, release decisions and semantic clustering remain outside this work.

CURRENT: PostgreSQL population provenance is unchanged. SQLite populations
use `snapshotProvenance: "sqlite-serialized-freeze/v1"` instead of a PostgreSQL
transaction snapshot ID. Shared schemas and consumers explicitly accept the two
variants and reject mixed or unspecified provenance. No historical evidence
format or digest basis has been silently changed.

Exact artifact bytes use BLOB storage. Governed JSON hashing retains PostgreSQL
numeric semantics, UTF-16 contract ordering and the existing timestamp bases.
Candidate regression copies retain source payload TEXT verbatim and enforce the
same binary64 round-trip acceptance as the PostgreSQL command. Real PostgreSQL
oracle tests cover scaled numbers, large integers, exponent notation and
subnormal typed thresholds. Lifecycle event hashes use raw stored identity
strings after validating the public shape; schema trimming cannot change the
hashed basis.

## Enforcement boundaries

CURRENT: a synchronous managed write owns `BEGIN IMMEDIATE`, a private command
token and a persisted non-decreasing millisecond clock sampled after acquiring
the write lock. Transaction/savepoint escapes and use after completion fail.
Equal timestamps are allowed; final-validation evaluator reuse still requires
strict pretest ordering, as in PostgreSQL.

Complete immutable bundles require reciprocal deferred foreign-key obligations
and guarded finalization records. Finalizers check the retained joined evidence;
child and source guards reject trailing same-command changes. Payload-heavy
validators are scoped, read-only, non-reentrant and available only to their
named triggers. Plain connections can read projections and run integrity/FK
checks; writes that need unavailable validators fail closed. Administrative DDL
capable of removing guards is outside this data-write enforcement boundary.

Calibration capability and provider-policy snapshot semantics remain application
logic, matching PostgreSQL; the database checks exact snapshot byte digests and
ownership. Authorization claims, protected-revision leases, attempt accounting,
terminal aggregate/private-ledger minting and lease release are atomic guarded
bundles. A started provider call is durable before dispatch; uncertain recovery
cannot silently dispatch it again as fresh work. Public reads never expose the
private attempt ledger or protected item payloads.

Lifecycle activation binds complete retained calibration and passing full
regression evidence. Replacement retires the previous active evaluator in the
same reciprocal bundle. Revocation appends needs-review atomically, including
when an outer conflict clause would otherwise ignore the event. Implicit
selectors and suite publication require current admissibility; explicit
nonproduction contexts follow the existing lifecycle contract. Authorization
records pin the exact current lifecycle head and artifact.

Measurement reads use one transaction snapshot, verify retained aggregate bytes
and binding before parsing, and derive current status without modifying the
historical artifact. Production outcome monitoring remains ungoverned feedback.

## Inventory and validation evidence

CURRENT: the original [PostgreSQL inventory](invariant-inventory.json) remains
an immutable baseline with its historical planned-port labels. The separate
[port map](invariant-port-map.json) accounts for all 206 function definitions
(including one superseded definition) and 182 triggers by inventory ID and source
hash. It links each to current SQLite migrations, command/projection modules and
positive/adversarial domain suites. Shared PG guards can map to several
SQLite table-specific guards; an identical SQL symbol name is not required.

The map guard checks coverage, unique IDs, source hashes and existing references.
It does **not** infer semantic test coverage from a filename. Independent
per-predicate audits and executed suites provide that evidence. The audits found
and prompted corrections for raw lifecycle hashing, activation-cited regression
no-op updates, subject no-op updates, and semantic truth-label set validation.
Additional direct-SQL tests isolate source changes after finalization, an
internally consistent incorrect draw, foreign child-label membership, invalid
barrier transitions, stale authorization pins and valid canonical manifests for
ineligible lifecycle states.

CURRENT consolidated test/build/CI results will be recorded after the final
qualification run. The milestone is not merge-ready until those checks and
Copilot review are complete. Earlier slice counts in the progress record are
historical checkpoints, not a substitute for final qualification.
