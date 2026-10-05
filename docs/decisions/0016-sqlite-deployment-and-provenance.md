# ADR-0016: SQLite exact-byte storage and Analyze snapshot provenance

Status: **Proposed** — technical contract refinements awaiting founder review.
Date: 2026-10-05.

## Already authorized scope

TARGET: the user requested two fixed installation templates for the same
Rubrist application, one SQLite and one PostgreSQL, each with one database for
application state, Better Auth and jobs. Initial SQLite topology is one
application instance on one host with durable local storage. This scope is
already authorized; this ADR does not reopen it or add unrelated roadmap gates.

## Proposed narrow refinements

1. Extend ADR-0006's PostgreSQL `bytea` storage prescription to SQLite `BLOB`
   for SQLite installations. Preserve identical canonical UTF-8 bytes, whole-byte
   digest, evidence digest, immutable lineage, terminalization atomicity and
   tenant-erasure boundary. No evidence wire format changes.
2. Keep existing PG Analyze responses and stored evidence unchanged. Define a
   new explicit Analyze response version/negotiation boundary before SQLite
   Analyze ships. Replace its PG-only `snapshotXid8` field with the strict
   discriminated provenance described in the
   [Milestone 0 design](../sqlite/milestone-0.md#snapshot-provenance-and-compatibility).
   PG retains the real snapshot text. SQLite states serialized-freeze semantics
   and server time with no fabricated snapshot ID. Existing content/frame/draw
   digest bases remain unchanged; no rehashing retained populations.
3. Preserve all four applied PostgreSQL migrations and checksums. SQLite has
   its own history. No database conversion, baseline reset, or hosted evidence
   deletion is authorized by this work.

## Evidence and remaining gate

CURRENT: isolated tests establish deferred finalization, per-command validation,
exact BLOB retention, managed transaction identity, WAL isolation and durable
execution fencing. They do not implement the application SQLite backend.

ASSUMPTION: the mechanisms can preserve current guarantees through the full
port. Each inventory item still needs domain tests. The exact new Analyze API
version/negotiation surface and reader migration must be settled before runtime
provenance changes. No application behavior depending on this proposed ADR is
implemented in Milestone 0. Authentication/startup work may proceed independently;
BLOB evidence porting and new public Analyze responses wait for this decision.
