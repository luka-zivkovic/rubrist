# Milestone 0 validation and independent review

Status: CURRENT validation record, 2026-10-05.
Scope: isolated prototypes, source inventory, design/ADR and handoff documentation.
Application runtime, PostgreSQL migration bytes and public contracts are unchanged.

## Executed checks

| Check | Result |
| --- | --- |
| Node 24.15.0 / SQLite 3.51.3, macOS arm64 | Runtime identity verified |
| `node --test tools/sqlite-prototype.test.mjs tools/sqlite-inventory.test.mjs` | 19 passed, zero skipped; rerun after all Copilot follow-up corrections |
| All root Node test globs (`tools/*.test.mjs tools/ci/*.test.mjs tools/mcp/*.test.mjs`) | 47 passed, zero skipped; focused SQLite tests rerun after final cascade fix |
| `pnpm typecheck` | Passed |
| `pnpm build` | Passed; existing web bundle-size advisory |
| `pnpm shared-contracts` | Passed: 30 modules, 1,127 public exports, 637 runtime exports |
| `pnpm repository-boundaries` | Passed: 36 transaction owners, one session-lock owner, 17 client-scoped commands |
| Initial `pnpm test` | 2,030 Vitest tests passed, 165 skipped, one existing test timed out; Node phase separately passed |
| `pnpm exec vitest run --maxWorkers=2` | Passed: 247 files, 2,031 tests; 40 files / 165 tests skipped |
| `pnpm test:pg` | Unavailable: Docker daemon socket absent (Colima stopped); no PG test ran |
| Source inventory migration hashes | All four migrations match the unchanged baseline checkout |
| `git diff --check` and `git diff --cached --check` | Passed on final scope |
| `pnpm large-files` | Exited 0; new inventory classified generated; five existing files still carry review-required advisories |

The initial timeout was
`apps/api/test/demo-repository-store.test.ts` → “rejects aliased and reflective
allocations plus type-erased module loading” (30-second limit). It occurred
while the broad suite, typecheck and repository-boundary checks ran concurrently.
CURRENT: the rerun passed with two workers and unchanged tests. ASSUMPTION:
resource contention caused the initial timeout.
The 165 skipped tests are not evidence of database parity. No PostgreSQL
application or migration code was changed by this checkpoint; the unavailable
PG regression run must remain visible and be rerun when its disposable service
is available. No existing installation was started, reset or accessed.

## Independent agent audit

The repository-required independent agent `/root/milestone0_audit` reviewed the
exact Milestone 0 additions, proposed ADR/index, handoff and generated inventory.
It independently ran the 13 focused tests and checked migration hashes,
source counts, digest exclusions, contract gates and test-claim boundaries.

Finding and correction:

1. A raw UPDATE could repoint a retained handoff to a newly created bundle in
   the same command, bypassing the INSERT-only previously-committed guard.
   Handoffs now reject UPDATE and direct DELETE/REPLACE. The FK now cascades
   during parent erasure, with a parent-aware deletion guard. Tests reproduce
   same-command UPDATE, replacement and direct deletion, and prove tenant
   erasure with a retained handoff. The reviewer independently reran all 13
   tests and confirmed both the bypass and related erasure issue are resolved.

CURRENT reviewer result: no remaining correctness findings. The reviewer also
reviewed this validation record and confirmed its coverage limitations are
accurate. Final test results and staged checks above replace the in-progress
entries reviewed during the run. The local checkpoint is on branch
`sqlite-milestone-0`, with commit subject “Prototype SQLite deployment integrity
and recovery (Milestone 0)”.

## Boundaries retained for continuation

- SQLite application startup, authentication, repositories, queue parity and
  deployment templates remain unimplemented (Milestones 1–6).
- SQL prototypes prove mechanisms; the per-symbol domain tests in the invariant
  inventory remain explicitly planned. No promised evidence guard is removed.
- Proposed ADR-0016 needs the applicable founder decision before BLOB evidence
  runtime and Analyze response changes. Authentication/startup can proceed
  independently. Public API version/negotiation remains to be specified.
- Node/Linux release packaging, performance, full queue leasing/renewal,
  power-loss durability and installation restore drills remain unqualified.
- This checkpoint stopped at the reviewed Milestone 0 boundary. Subsequent
  user authorization permits continuing through separately reviewed milestones.

## PR #192 Copilot follow-up

CURRENT: Copilot identified a managed-callback transaction escape and a missing
source-count check for trigger parsing. The callback now receives only SQL
operations; a SQLite authorizer denies top-level transaction control while the
callback runs, including statements prepared before the command. Savepoints
remain usable. Adversarial tests assert rollback, private-context cleanup and
no escaped autocommit writes. The authorizer is an application transaction
ownership boundary, not a sandbox against arbitrary trusted Node code.

Inventory generation now checks each migration's source trigger declaration
count against parsed triggers, supports `CREATE OR REPLACE TRIGGER`, and fails
closed for unsupported quoted trigger syntax. Generated inventory bytes and
all migration hashes remain unchanged. The independent follow-up audit found
two additional cases: implicit rollback followed by an autocommit write, and an
unsupported trigger on the same source line as another statement. Operations
and prepared statements now check the current command's ownership before every
execution; source counting no longer depends on line starts. Regressions cover
both cases and stale command/statement reuse. Both focused suites pass all 16
tests, also independently rerun by the reviewer with no remaining blockers.
The next Copilot round found initialization cleanup and function-count gaps.
Transaction initialization now sits inside the rollback boundary, with a clock
failure regression proving connection and competing-writer recovery. Function
declaration counting also ignores line position and rejects unsupported quoted
names. The current focused total is 18 passing tests (15 prototype, three
inventory). Earlier counts above identify the historical runs they describe.
The independent reviewer reran all 18 tests and approved this correction with no
remaining blockers. A further review found inconsistent lease clock sampling:
ownership UPDATEs and their triggers now use the same captured command time.
An advancing-clock regression covers short TTLs, exact expiry, replacement,
completion and recovery. The latest independent audit reran and approved all
19 focused tests (16 prototype, three inventory). Fresh Copilot review and CI
are still required before merge.
