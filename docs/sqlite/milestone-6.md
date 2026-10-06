# Milestone 6: parity and release qualification

**CURRENT (2026-10-06):** all seven milestones are implemented and locally
qualified. The stacked PR review/merge workflow remains pending: only Milestones
0–1 have merged. Fresh Copilot reviews have not started despite accepted requests.
This record does not authorize a release or an upgrade of an existing installation.

## Behavioral and recovery checklist

| Boundary | CURRENT executable evidence |
| --- | --- |
| PostgreSQL and SQLite evaluation contract | `evaluation-storage-contract.test.ts` runs both real backends: overlapping deliveries, stale owners, terminal replay, one verdict/receipt/counter and foreign-project denial. Database tests require explicit disposable PostgreSQL configuration; skips are not parity evidence. |
| Lease expiry while waiting for a lock | Four PostgreSQL regressions hold an unchanged tuple lock across expiry before dispatch, return, completion or failure. Each operation is rejected. The independent reproducer also passes. |
| Job creation and delivery | Existing SQLite workflow tests interrupt after durable run creation before queue send, recover stable dispatch IDs and reject duplicate submissions. Queue tests cover claim/retry/recovery and stale acknowledgements. |
| Pre-dispatch crash | Production worker child is SIGKILLed after its committed claim. Replacement may dispatch once after expiry. |
| Dispatch and post-result crash | Production child is SIGKILLed during dispatch or after durable verdict insertion. Recovery records `outcome_unknown`, never guesses an outcome and never repeats the physical call. |
| Receipt transaction | Injected mint failure rolls back terminal item/counter state. Retried completion mints one immutable receipt; invalid direct writes fail closed. |
| Terminal commit before acknowledgement | Real queue handler commits its receipt, acknowledgement fails, process runtime closes/reopens, lease expires and delivery repeats. One physical call, verdict, artifact and counter remain; queue reaches completed. |
| Ordinary and specialist workflows | Milestones 3–4 inventory and negative boundary suites retain coverage for integrations, review, analysis, governed truth, calibration, lifecycle, monitoring and measurement. |
| Operator recovery | Milestone 5 container drills exercise both backends, SQLite backup/fresh-volume restore, synthetic predecessor upgrade and old-backup rollback. Restored encrypted credentials and governed artifact bytes are independently tested. |

The prototype's Milestone 0 crash experiments are mechanism evidence. They are
not substituted for the production-worker tests above. Regression and calibration
fault suites retained from Milestones 3–4 cover their distinct execution owners.

The shared test found a PostgreSQL lease-fencing defect: execution-token matching
alone admitted expired callbacks; a duplicate delivery could also classify a
returned response while its owner was still live. PostgreSQL now requires a live
lease for token-bearing dispatch/return/completion/failure and expired ownership
for recovery classification. It locks the scoped item before sampling the clock,
because an UPDATE predicate can otherwise be evaluated before a row-lock wait.
The boundary inventory records the two new short transaction owners; existing
terminalization keeps its item-then-run-counter lock order. Legacy tokenless
PostgreSQL calls retain their compatibility behavior; this is not a claim that
every internal optional argument is identical across backends.

## Packaging

CI retains the full explicit PostgreSQL suite, SQLite tests, shared-contract and
repository guards. A separate disposable-container job builds the exact checkout
and exercises both fixed installation templates. CI and release Node are pinned
to 24.21.0; the containers pin that version and its manifest digest. The local
minimum is Node 24.15.0. No public evidence schema or package export changes are
introduced in this milestone.

Release verification checks both Compose/checksum pairs. After publication, the
release workflow pulls the exact tags and performs the same account, harness,
mock-evaluation, byte-preserving restart/replacement and SQLite restore drills.
Only passing smoke checks create the operator-reviewed draft with both Compose
pairs and both Coolify recipes. No release tag was pushed during qualification.

The large-file inventory records four previously unclassified files: the AST
boundary fixture is generated, application composition and PostgreSQL auth tests
are refactor candidates, and the production-calibration contract is marked for
cohesion review. No size threshold, transaction guard or contract guard is relaxed.

## Measured operating guidance

The reproducible synthetic workload is `tools/bench/sqlite-workload.ts`;
[raw observations and reproduction steps](benchmarks/README.md) record the
hardware, runtime, concurrency and measurement limits. On an Apple M4 with ten
logical CPUs and 16 GiB memory, Node 24.15.0 / SQLite 3.51.3, the workload uses
4 KiB synthetic context, eight import clients, 50 reviews, 100 durable mock
evaluations, 100 overlapping imports, population reads and three retention sweeps.
Other local qualification work was running; these are observations, not capacity
guarantees. The explicit 65-second population maturation wait is excluded from
the overlapping-work duration below.

| 5,000-member population | Before indexes (0065) | After indexes (0066) |
| --- | ---: | ---: |
| Overlapping workload | 63.77 s | 9.73 s |
| Retention median | 17,996.95 ms | 18.62 ms |
| Dashboard read p95 | 17,775.95 ms | 19.56 ms |
| Population freeze | 3.62 s | 3.40 s |
| Main-thread event-loop p95 | 12.35 ms | 12.32 ms |
| Durable completed jobs / mock calls | 100 / 100 | 100 / 100 |
| Sampled database peak | 90.69 MB | 91.87 MB |
| Sampled WAL peak | 36.39 MB | 36.09 MB |

Both runs had no recorded operation errors and preserved every frozen member
through all three retention sweeps. A separate 100 ms maintenance-writer lock
probe completed in 128 ms in the indexed run. It is not a second application
instance. RPC latency includes waiting behind serialized commands; 25 ms disk
samples are not exact high-water marks. Event-loop measurements concern the
main thread, not storage-worker execution.

The measured slowdown identified missing case-specific retention access paths.
Migration 0066 adds five nonunique indexes without rewriting history, deleting
rows, relaxing guards or changing evidence contracts. Independent query-plan
review confirmed exact lookups; migration integrity and foreign-key checks pass.

**Operating guidance:** keep SQLite to one API instance on durable local storage.
Schedule large population freezes away from interactive peaks: the 5,000-member
freeze still delayed some dashboard/review requests by roughly 3–4 seconds,
which can exceed the bounded readiness probe. Main-thread responsiveness does
not mean storage requests cannot wait. Monitor command latency, queue progress,
readiness and WAL growth on the actual installation; choose PostgreSQL when
concurrent workload latency needs exceed those observations. Budget disk for
the live database, WAL, retained backups and restore temporary files. Test
restores with the separately held secret. No user-count limit or paid-provider
throughput is inferred from local mock calls.

## Validation and review

- Independent PostgreSQL fencing audit: 8/8 shared/lock-expiry contract tests.
- Focused contract plus PostgreSQL convergence: 11/11.
- Independent production crash/acknowledgement audit: 15/15.
- Workspace typecheck, shared exports and repository boundaries pass.
- Final schema 0066 full regression: **2,855/2,855 tests in 362 files**, zero
  skips, plus **57/57 tooling tests**. The earlier pre-index full run also passed.
- Final migration/storage/workflow/restore focused suite: 29/29; backup/installer:
  3/3. Independent index migration integrity and query-plan review passed.
- Complete pinned-image builds pass. Final API image `ac98a3f4ee54` and web image
  `a426702e35d9` passed both backend installation/restart/replacement drills.
  SQLite also passed backup/fresh-volume restore, Milestone 5 schema-0065 upgrade
  to 0066, older-image refusal and restoration with the predecessor image.
  These are unreleased qualification images, not a historical published release.
- Both exact-final-script workload sizes independently approved: 100 durable
  jobs and 100 mock calls in each; no recorded operation errors. Standalone strict
  benchmark typecheck passes. Four raw result files preserve before/after evidence.
- Independent packaging audit approved CI/release gates and six release assets.
  YAML parsing, checksum/render checks, shared contracts, repository boundaries,
  large-file classification and diff checks pass.
- PR CI and Copilot reviews remain required before bottom-up merging. Copilot
  availability is an external merge gate, not approval. No release/deployment ran.
