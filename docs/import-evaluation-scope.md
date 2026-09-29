# Automatic import evaluation scope

TARGET: importing selected cases with an evaluator must not silently evaluate
unrelated historical cases. Existing-case evaluation remains an explicit choice.

CURRENT repair contract:

| Event | Evaluation scope |
| --- | --- |
| First import for an evaluator, including `timeScope: new` | Only the supplied case IDs |
| Repeated or concurrent imports of the same case/version | Reuse one durable per-case evaluation run |
| Import overlaps an already saved backfill | Reuse covered items without expanding that run |
| Explicit existing/both scope after the gate passes | Preserve the saved historical backfill behavior |
| First-assessment screen | Track/resume saved work; never create a backfill just because no run is visible |
| Explicit “Evaluate existing cases” action | Start the historical backfill if no saved work or assessment already exists |

No historical runs, assessments, or human reviews are rewritten. No migration is
needed. The existing API `backfillRunId` field remains null for per-case runs.
The first-assessment list is filtered by evaluator version and run purpose before applying its
limit, so unrelated runs cannot hide saved work. Unfinished work is selected
before terminal runs; an existing recorded assessment completes onboarding
even if another imported case later fails.

Verification covers new-version imports with historical cases present, empty
imports, duplicate/concurrent imports, saved backfills, first-assessment
continuation, filtered run lookup, queue failure/retry, and PostgreSQL durable
run identity. These are execution-scope checks, not evaluator accuracy claims.
