# SQLite Milestone 2 — durable evaluation workflow

Status: **In progress**. Milestone 1 is merged. ADR-0016 was accepted by the
founder on 2026-10-05 after the Claude Code consultation. No Milestone 2 runtime
or product-parity claim is complete until the validation and review record says so.

## TARGET and transaction boundaries

Implement the deployment plan's evaluation slice through the existing repository
and queue ports. Keep model calls outside write transactions. The SQLite storage
worker owns short synchronous commands; application workers perform network work
and return with fenced ownership tokens. Evidence uses shared canonicalization,
STRICT BLOB storage, and receipt minting in the run's terminal transaction.
Lifecycle authorization remains mandatory, including for receipt-producing runs.

## Job state machine

Each job has a stable `(queue, id)`, immutable JSON input and retry policy, a
creation timestamp, next eligible time, and optional epoch-aligned singleton
slot. Duplicate IDs or occupied singleton slots return null. Completed job IDs
remain retained for dispatch reconciliation. The initial implementation does not
prune job identities.

| Prior state | Event | Next state | Required condition |
| --- | --- | --- | --- |
| created / retry | claim | active | eligible time reached; fresh random ownership token |
| active | acknowledge | completed | exact token and unexpired lease |
| active | handler failure | retry / failed | exact token and unexpired lease; bounded retry budget |
| active | lease expiry | retry / failed | expired lease; same bounded retry budget |
| terminal | any delivery mutation | unchanged | no resurrection |

Retry count means retries consumed: the first claim is zero; each transition to
retry increments it once. Delay is policy delay (at least one second when backoff is enabled),
multiplied exponentially when requested, with a bounded exponent. Expiry applies to an active delivery, not
queue waiting time. Claim/recovery/acknowledgement each acquire their own write
transaction and capture current time after acquiring the lock. Recovery clears
expired tokens before another handler can claim. A late handler cannot acknowledge
or fail its replacement. Queue retries never grant permission to repeat an
external model call; the evaluation item's durable pre/post-dispatch state is the
separate authority for that decision.

The queue adapter limits concurrently leased handlers per queue and recovers
expiry even when all slots are occupied. Expiry releases the local slot and
fences acknowledgement; it cannot cancel an external call already in flight.
Domain execution tokens remain mandatory to reject late evidence or repeated
provider dispatch. Shutdown stops new claims and drains for up to ten seconds;
unfinished deliveries retain their persisted leases for restart recovery. No
unfinished callback is acknowledged merely because shutdown reached its deadline.

## Required fixtures before claiming completion

- Concurrent duplicate sends and claims; different queue/name isolation.
- Persisted job input and state across connection/worker restart.
- Retry exhaustion, backoff eligibility, expiry on the last attempt, stale
  acknowledgement/failure rejection, and simultaneous expired-lease recovery.
- Parallel handlers, clean shutdown, failed storage commands, and eventual
  delivery without holding a transaction across a handler.
- Evaluation provider interruption before dispatch and uncertainty after it;
  atomic terminal receipt bytes, tamper rejection, unchanged bytes after restart.
- Full authenticated synthetic workflow, tenant isolation, lifecycle rejection,
  and PostgreSQL regression coverage.

## CURRENT implemented boundary

The SQLite runtime starts the durable queue and shared evaluation workers.
Native criterion/evaluator creation preserves shared schemas, immutable bindings,
author subjects and execution-authorization digests. Direct incomplete
analysis-derived bundles and unverifiable regression revision pins fail closed.
RPC preserves repository error classes and revives BLOBs as Buffers.

The staged HTTP allowlist exposes native criterion authoring, collection
management, ordinary collection evaluations, API batch evaluation and receipt
retrieval/comparison. Unported routes still fail closed. Complete agent bootstrap,
integrations, immutable revisions and governed lifecycles remain later work.

Independent interim audits found and resolved full-slot lease recovery, zero-delay
backoff, polling-generation restart races, mutable criterion author links, and
unverified regression pins. Regression fixtures cover each finding. The final execution and HTTP audit is recorded in the validation document.

Native trace import and mutable dataset collections are now implemented. Imports
preserve first-origin purpose, source-version/remote-project identity, shared
redaction, pre-redaction input identity, and transactional traffic counts. Input
identity rows survive raw traffic retention. Collection adds preserve existing
labels/notes, clear a failure step on an explicit pass, and roll back the complete
batch on invalid membership. Integration imports, immutable revisions, and bulk
example import remain unavailable. Negative, fractional, and unsafe query limits
are rejected instead of invoking SQLite's unlimited negative-LIMIT behavior.

## Evaluation execution implementation contract

TARGET: native `release_evidence` batches use the existing worker and receipt
contracts. The compatibility rule for native lineages without governed lifecycle
records comes from ADR-0010; it never asserts activation or calibration.

| Item state | Delivery event | Result |
| --- | --- | --- |
| pending, unclaimed | claim | persist fresh token and lease |
| pending, live claim | duplicate claim | busy; no second provider call |
| pending, expired pre-call claim | claim | replace token; former owner cannot dispatch or finish |
| pending, expired post-dispatch claim | recovery | outcome unknown; no repeat provider call |
| pending, live token, no dispatch marker | dispatch | durably record marker before external call |
| pending, live token, dispatched | provider returns | durably record return marker |
| pending, live token, returned | complete | item verdict, counters and terminal receipt commit together |
| terminal | replay | preserve prior evidence and counters |

Queue delivery ownership and domain execution ownership remain separate.
A returned marker alone does not prove the original live worker died. Recovery
must respect the original lease before declaring its result unknown. A successful
completion requires the current unexpired domain token. Recovery may terminalize
an expired claim as unknown/not-attempted only while that exact claim still owns
the pending item. No transaction spans a provider request.

The terminal run stores exact receipt bytes in its terminalization transaction.
Receipt reads validate retained canonical bytes and digest without reconstructing
them. Corrections append lineage; comparisons retain the consumer's exact bytes.
Schema and direct-write tests must enforce tenant ownership, lineage, immutable
artifacts, and project-erasure boundaries. SQLite worker transport must revive
artifact BLOBs as Buffer values for existing HTTP consumers.

CURRENT: migration `0006_evaluation.sql` applies the run/item, verdict and
receipt consistency group. Its deferred reciprocal key prevents a terminal
release-evidence run committing without its root artifact. Receipt comparisons
and corrections retain exact canonical BLOBs; correction reasons and immediate
predecessors are mandatory. Completed item verdicts must match the run's exact
evaluator version and case. Terminal evidence cannot be rewritten.

Mutable dataset-item removal clears only its optional item link; item snapshots
remain. Raw-case retention follows existing PostgreSQL cascades while retained
receipt artifacts survive. Project erasure removes the whole evidence graph.
SQLite integrity checks work without application functions; artifact-writing
triggers require registered validators. Lease time uses integer epoch
milliseconds captured after acquiring the write lock; API timestamps use UTC
ISO strings with millisecond precision.

Pending items receive recovery deadlines in their creation transaction, so a
process death before queue send is recoverable. Model calls run outside storage
transactions. The runtime stops the recovery timer before closing the queue and
storage. The startup recovery sweep and periodic sweep use the same fenced
repository commands as ordinary workers.
