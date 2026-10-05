# ADR-0016: SQLite exact-byte storage and Analyze snapshot provenance

Status: **Accepted** — founder approved on 2026-10-05 after independent Claude Code consultation, with the clarifications below.
Date: 2026-10-05.

## Authorized scope

TARGET: the user requested two fixed installation templates for the same
Rubrist application, one SQLite and one PostgreSQL, each with one database for
application state, Better Auth and jobs. Initial SQLite topology is one
application instance on one host with durable local storage. This ADR does not
reopen that scope or add unrelated roadmap gates.

## Decision

1. Extend ADR-0006's PostgreSQL `bytea` storage prescription to SQLite `BLOB`
   for SQLite installations. This applies to every retained exact-byte artifact:
   assessment receipts and comparisons, binary calibration artifacts and private
   ledgers, exposure-check and policy bytes, suite manifests, imported-truth
   source artifacts, and production calibration snapshots. Preserve original
   bytes, whole-byte digests, domain evidence digests, immutable lineage,
   terminalization atomicity, and the applicable tenant-erasure boundary.
   Canonical artifacts retain the existing canonicalization; raw source artifacts
   retain their original bytes without invented canonicalization. No evidence
   wire format changes are authorized. Use STRICT BLOB storage and return stored
   bytes, not reconstructed JSON.
2. Preserve existing PostgreSQL Analyze responses and stored evidence. SQLite
   provenance must explicitly state serialized-freeze semantics and server time,
   with no fabricated PostgreSQL snapshot ID. PostgreSQL retains its real
   snapshot text. A strict backend-discriminated provenance representation is
   authorized; the exact DTO/transport choice (a versioned boundary or a strict
   union with coordinated reader changes) is an implementation decision for
   Milestone 4, subject to compatibility tests. This decision does not require a
   new API version in advance. The known in-repository consumer is the web app;
   confirm other consumers before shipping any changed response. Existing
   content/frame/draw digest bases remain unchanged; do not rehash populations.
   Capture freeze and ingestion timestamps within the owning write transaction.
   Preserve the existing 60-second window guard. Document actual timestamp
   precision when selecting the Milestone 4 representation.
3. Preserve all four applied PostgreSQL migrations and checksums. SQLite has
   its own history. No database conversion, baseline reset, or hosted evidence
   deletion is authorized by this work.

## Enforcement and operational compatibility

TARGET: retain each domain's documented enforcement guarantees. This decision
is not a claim that PostgreSQL verifies every artifact hash in a database
constraint. Reuse shared canonicalization and digest helpers, and test Unicode
ordering, numbers, timestamp precision, and exact bytes against common vectors.

SQLite application-defined functions in CHECK constraints can prevent an
ordinary connection from running integrity checks or `VACUUM INTO`. Prefer
trigger-based digest validation where database enforcement is required, or
provide and test a maintenance connection that registers the required functions.
Plain writes must not bypass validation when those functions are unavailable.
Backup/restore qualification must exercise the selected enforcement boundary.

## Evidence and remaining implementation work

CURRENT: Milestone 0 isolated tests establish deferred finalization, per-command
validation, exact BLOB retention, managed transaction identity, WAL isolation,
and durable execution fencing. Milestone 1 implements persistent SQLite accounts.
Neither establishes full evidence or Analyze parity.

ASSUMPTION: these mechanisms can preserve current guarantees through the full
port. Each inventory item still needs domain tests. Milestone 4 must settle and
test the Analyze transport and reader migration before provenance changes ship.
ADR approval permits BLOB evidence porting; it does not waive domain checks,
independent audits, or compatibility validation.
