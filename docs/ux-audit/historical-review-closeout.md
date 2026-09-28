# Historical review closeout

Status: **CURRENT implementation change**, 2026-09-28. This is a bounded
correctness repair supporting the public-data test closeout and triage slice;
it does not depend on proposed ADR-0015.

## Problem and behavior

Saved queue items already carry an exact criterion definition revision. The
player previously ignored it and requested the dashboard's current evaluator
version. An older case disappeared behind “Case not found” whenever that
version had not evaluated it. Switching the selected criterion could also
cause the player to request evidence unrelated to its task.

Case detail now accepts `criterionVersionId`, optionally together with an exact
`skillVersionId`. Both constraints apply when both are supplied. Project scope
is always enforced. Saved queues use each item's criterion pin, ad hoc review
uses the exception's pin (or the selected definition), and ordinary case links
use the selected definition. Explicit evaluator links still request only that
evaluator. No read re-evaluates a case or calls a provider.

Within the named criterion, the server returns the latest recorded judge run
with deterministic timestamp/ID ordering. Human review and golden promotion
continue to submit the exact evaluator version in that displayed result. The
queue task does **not** freeze a particular evaluator run at creation; this
change does not pretend otherwise. Existing verdicts remain append-only and
review history remains isolated to the same exact criterion definition.

A criterion-scoped miss returns `case_evaluation_unavailable` with an explicit
missing-result message, not a result from another criterion. The player shows
the error with Retry and no review actions. It never fetches unscoped evidence
while waiting for the selected definition. Its detail component resets when
moving between different task identities, including the same case reviewed
against different criteria.

## Verification

Regression coverage exercises:

- a saved queue whose case was evaluated only by an older evaluator;
- a newer result for another criterion that must not replace that evidence;
- read/write attribution to the displayed historical evaluator;
- completion of only the matching criterion's queue task;
- missing results, conflicting selectors, and foreign-project reads;
- rendered saved queues, ad hoc review, ordinary and explicitly pinned case
  links, Retry, and same-case navigation between criterion definitions;
- PostgreSQL 17 behavior as well as the demo repository and API.

The change creates no human verdicts in the hosted benchmark. Its eight-case
human calibration review remains a separate user task. This closeout also does
not change held-out reference labels, run paid evaluations, implement cascade,
or upgrade operational triage to governed human truth.
