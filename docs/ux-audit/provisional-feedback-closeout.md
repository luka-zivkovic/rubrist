# Provisional feedback closeout

Status: **CURRENT implementation**, 2026-09-28. Bounded correction for G1 and
its sign-off consequence; no vocabulary/display decision or schema change.

Feedback delivery now reads the exact evaluator version recorded on the judge
run. A draft with no approval timestamp is parked in the existing durable
`blocked` state before constructing an upstream writer. Local results remain
available. The pause records a specific sign-off reason and consumes no
provider-call or queue-retry budget. Global starter state and approval of a
newer version cannot release an older draft's results.

The feedback worker checks for up to 100 held jobs at startup and every 30
seconds. Only the specific sign-off pause, joined to an approval timestamp on
that same version, is eligible. Dispatch leaves the durable row blocked until
delivery: a failed/ambiguous queue send, worker restart, or sign-off racing a
worker that is still parking a result leaves recoverable work. Signing off a
version therefore needs no cross-system transaction or new inference.

Delivery retains the original feedback ID as the provider idempotency key.
Duplicate deliveries after a recorded success skip the writer. Concurrent
in-flight deliveries can still reach the provider with that same ID, as on
the existing retry path. Provider failures use the existing failed state and
finite queue retries; permanent credential/provider failures and integration
revalidation still require their existing recovery procedures. The resumer
does not clear unrelated blocked reasons or retry ordinary failed deliveries.

The sign-off action now asks the owner to confirm that held results for this
exact version become eligible for upstream delivery. It explains that this
neither reruns evaluation nor supplies governed calibration. Delivery normally
starts within the recovery cadence with a running worker and available queue.

Verification uses disposable PostgreSQL 17 and injected feedback writers,
not actual tracing-provider requests. It covers unsigned hold, duplicate
worker delivery, approval of another version, approval/parking race, queue
throw/null recovery and process restart, provider retry with the same feedback
ID, no additional judge runs, successful coverage, and already-synced no-op.
Separate tests cover startup/timer recovery and continuing after one dispatch
failure. Existing successful delivery fixtures now explicitly sign off their
versions instead of accidentally relying on unsigned-draft delivery.

The recovery batch is bounded; full application-scale recovery query load has
not been benchmarked. No hosted judgments or WiCE artifacts are changed.
