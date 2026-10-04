# Milestone 0 validation and independent review

Status: CURRENT validation record, 2026-10-05.
Scope: isolated prototypes, source inventory, design/ADR and handoff documentation.
Application runtime, PostgreSQL migration bytes and public contracts are unchanged.

## Executed checks

| Check | Result |
| --- | --- |
| Node 24.15.0 / SQLite 3.51.3, macOS arm64 | Runtime identity verified |
| `node --test tools/sqlite-prototype.test.mjs tools/sqlite-inventory.test.mjs` | 13 passed, zero skipped; rerun after audit fixes |
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
- Stop at this reviewed Milestone 0 boundary, as required by the repository's
  regular batch flow, before mixing in Milestone 1.
