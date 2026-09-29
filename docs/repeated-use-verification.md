# Repeated-use reliability verification

**CURRENT scope, 2026-09-29:** a deterministic integration scenario exercises
imports, evaluator execution and saved review history in disposable PostgreSQL.
It adds coverage across the lifecycle already implemented; it changes no
product behavior or governance policy.

## Scenario

The test uses twelve synthetic cases across three batches and two evaluator
versions. A mock provider records every call and returns deterministic opinions.
All reviewer submissions are synthetic fixtures in the disposable database;
they are not observations by people or calibration evidence.

1. Import four cases, then inject a queue-dispatch failure. Concurrent retries
   and duplicate case ids recover the persisted work with four provider calls.
   Replaying the same import preserves case identities, and redelivering a
   completed run makes no additional provider call.
2. Save four suggested results with their exact evidence pins. Duplicate review
   submissions produce one review; a later correction adds a second history
   entry and leaves the queue at one completed, three pending.
3. Create a new evaluator version through the repository workflow. Its empty
   reference check compares zero cases, which is not evidence of validity.
   Creation alone does not schedule historical reassessment.
4. Import two more batches of four cases. Only those cases run on the new
   version. A fresh repository instance between batches exercises recovery from
   stored state; requesting the former version for new judging is rejected.
5. Explicitly reassess three older cases with the new evaluator, reaching
   fifteen provider calls. Its changed instructions flip a borderline mock
   opinion from pass to fail. The old result, both review entries and all saved
   queue pins remain unchanged. New-version suggestions include the reassessed
   case despite its old-version review.

Every provider call receives the complete long policy and tool observation;
secret fields remain redacted. The scenario checks all original judge rows for
changes and finishes with exactly twelve stored cases.

## Reproduce

With Node 24, pnpm dependencies and Docker available:

```sh
pnpm typecheck
pnpm test:pg -- apps/api/test/repeated-use-lifecycle-pg.test.ts
```

`test:pg` creates and removes a disposable PostgreSQL 17 container and test
databases. Alternatively, supply `PG_SMOKE_DATABASE_URL` for a dedicated test
server with permission to create and drop databases. Never target a hosted
application database. CI includes this scenario in its PostgreSQL-backed suite.

## What remains untested by this scenario

This is a fast sequence of operations, not elapsed weeks of use. It does not
simulate a process crash, real queue transport, clock-dependent expiry or
retention, browser interactions, a live provider, Jev cascade decisions,
calibration quality, or changes to the agent under evaluation. It snapshots
operational judge rows and review history, not external assessment receipts.

Hosted provider setup/capability carry still needs its live check, as recorded
in the [roadmap](roadmap.md). Human usability and the effectiveness of review
prioritization remain separate pilot questions. No pilot labels, reserved cases
or production records are used by this test.
