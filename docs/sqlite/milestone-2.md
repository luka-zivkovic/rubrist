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

## CURRENT interim checkpoint

The queue foundation and native definition storage are implemented but not yet
connected to an HTTP evaluation workflow. The account-stage route boundary stays
in place. Native criterion/evaluator creation preserves shared schemas, immutable
bindings, author subjects, and execution-authorization digests. Direct incomplete
analysis-derived bundles and unverifiable regression revision pins fail closed;
the corresponding full domain ports remain outstanding. RPC preserves repository
error classes so route error handling continues to recognize domain failures.

Independent interim audits found and resolved full-slot lease recovery, zero-delay
backoff, polling-generation restart races, mutable criterion author links, and
unverified regression pins. Regression fixtures cover each finding. These audits
are not a completed Milestone 2 audit; no milestone PR is ready yet.
