# Milestone 1 validation and review

CURRENT record, 2026-10-05. Baseline: `d839575` (Milestone 0).

## Verified behavior

- SQLite source worker and compiled production entry start without
  `DATABASE_URL`, using a synthetic file and stable synthetic auth secret.
- Real Better Auth signup, sign-in, sign-out, cookies and database sessions;
  first-owner races create one user; worker and whole-server restart preserve
  sessions and projects. Compiled server exits cleanly on SIGTERM.
- Shared account contract runs on SQLite and PostgreSQL: membership isolation,
  owner/member authorization, invitations (email binding, expiration, invalid
  token before signup, one-time redemption race), API-key secrecy/revocation,
  pairing claim races, active-claim protection, expiration/replacement,
  revocation and one-time completion.
- Workspace creation recovery after auth signup interruption, idempotent
  workspace retry, and project recreation after deletion. Deletion retains
  audit attribution and removes the deleted project's keys.
- Provider credential ciphertext at rest, masked display, retrieval after
  restart and failure with a different secret. All credentials are synthetic;
  no provider calls or pilot data were used.
- Explicit backend configuration fails closed for empty, missing, malformed or
  contradictory settings. Incomplete persistent app composition is rejected.
- SQLite migration retry, checksum drift, incompatible/newer history, unknown
  file/database, rollback of partially applied SQL, foreign-key enforcement,
  file permissions and per-connection settings. Synchronized groups of eight
  workers open/migrate fresh files; a held writer does not block HTTP timers.
- Unported workflows return authenticated 503 responses; unauthenticated access
  still fails first. No demo fallback or evidence fabrication.

## Commands and results

Node 24.15.0, SQLite 3.51.3, PostgreSQL 17.11, pnpm 10.33.0.

| Check | Result |
| --- | --- |
| `pnpm exec vitest run --maxWorkers=2` | 249 files passed, 40 skipped; 2,059 tests passed, 171 skipped |
| `PG_SMOKE_DATABASE_URL=<disposable-local-db> pnpm test:pg` | 42 files, all 180 tests passed (includes the shared account contract on both backends) |
| `node --test tools/*.test.mjs tools/ci/*.test.mjs tools/mcp/*.test.mjs` | All 47 tests passed, including the M0 SQLite prototypes/inventory |
| `pnpm typecheck` and `pnpm build` | Passed |
| Compiled production API process smoke | Signup, restart, persisted session/project, 503 boundary and SIGTERM passed with no PostgreSQL URL |
| `pnpm repository-boundaries` | Passed; existing PostgreSQL transaction fixture unchanged |
| `pnpm shared-contracts` | Passed; no public contract changes |
| `pnpm large-files` | Passes in advisory mode; same five pre-existing unclassified paths remain |
| `git diff --check` | Passed |

The first broad test run caught old route test fixtures that provided a pool
without auth or used the old route `pool` option. Tests now compose the account
service and real authentication where required, retaining fail-closed assertions.
A saturated default-worker run timed out an existing expensive structural test;
the complete two-worker run passed. A first temporary PostgreSQL cluster used
SQL_ASCII and the host time zone; UTF8/UTC matching CI removed canonicalization
and retention fixture failures. No application workaround or migration change
was made for those environment mismatches.

Docker was unavailable. A new test-only Colima VM failed for insufficient disk
space and was removed. PostgreSQL 17 was installed through Homebrew and tests
used a disposable localhost cluster, not the default cluster or any existing
Rubrist database. No service was registered to start at login. The test cluster
is stopped and its temporary data removed after verification.

## Independent review

The repository's regular-batch flow requires an independent exact-diff audit.
The Milestone 1 reviewer identified and we corrected:

1. Busy handling must precede initial WAL setup. The connection constructor
   configures the timeout before WAL. A repeat review caught an
   intermittent WAL lock-upgrade conflict despite that timeout; bounded retries
   now close the failed connection before reopening. Ten synchronized groups
   of eight fresh-file opens exercise this path.
2. Project deletion must retain historical audit tenant attribution and the
   existing `project.delete` action. Metadata is updated in the same transaction
   before deletion, and the shared contract checks surviving records.
3. PG test restart teardown must not close the helper pool twice; signup-race
   tests must not assume which request wins. Both fixtures were corrected.

Final follow-up review approved the staged diff with no remaining blocking
findings. The reviewer independently reran the focused suite (28 passed, six PG
tests skipped without a PG URL) and stressed 360 synchronized opens/migrations
across 30 fresh files with zero failures. The full 180-test PostgreSQL result
above was verified by the implementation session.

## Remaining boundary

This validates the M1 account slice, not evaluator/evidence parity or a supported
SQLite release. Full bootstrap executes evaluator work and remains unavailable;
project eligibility uses an explicit temporary unconfigured state until M2.
Integration storage, jobs, immutable assessment evidence, advanced repositories,
installation templates and operational release gates remain later milestones.
Proposed ADR-0016 is unchanged and remains a decision gate for its own scope.

## PR #193 Copilot follow-up

CURRENT: the shared provider-key GET handler now requires project ownership,
matching the existing credential boundary. The account contract verifies owner
access and member/anonymous rejection on SQLite and PostgreSQL. An independent
review caught the related member Settings request: members now see an owner-only
explanation without making a protected request or offering an ineffective Retry
button. Owner and read-only demo behavior are preserved.

A real SQLite worker termination test covers an outstanding command, subsequent
commands, and repeated close after failure. The independent reviewer reran the
test and repeated actual-worker termination across 30 fresh runtimes, all passing.
The updated exact diff received independent approval with no remaining findings.

Node 24.15 follow-up validation: three focused API/UI suites pass 53 tests
(six PostgreSQL cases skipped in that invocation); a separate disposable UTF8/UTC
PostgreSQL run passes all 12 shared account-contract cases across both backends.
Type checking and `git diff --check` pass. The disposable PostgreSQL cluster was
stopped and removed. Fresh Copilot review and CI remain required before merge.

The next Copilot round identified setup lock starvation, a slow-body setup lock,
and invitation signup recovery. Setup now validates its body before locking.
PostgreSQL serializes local waiters and holds its advisory lock on a dedicated
session so auth/workspace commands retain the pool's capacity even with one
slot. The dedicated client observes connection errors and rejects after ongoing
work settles; its session always closes. The independent reviewer reproduced
the otherwise unhandled connection-error crash before this correction.

An invitation retry for an already-created user now requires successful sign-in
with that user's existing password before atomic redemption. Cookies are sent
only after redemption succeeds. Tests cover interruption and expiry after signup,
restart, the original or replacement invitation, rejection of a wrong password,
and one user/membership without consuming an invite on authentication failure.

Validation of this round: 12 concurrent setup requests with a one-slot PG pool,
an unfinished streaming request body, and both invitation recovery cases pass.
The complete PostgreSQL suite passes 186 tests; a subsequent focused run passes
all 19 account tests including new dedicated-connection termination/recovery.
The full non-PG suite passes 2,063 tests (174 skipped before adding that PG-only
failure test). Type checking and build pass. These counts describe their actual
invocations, not skipped database coverage. Fresh Copilot review and CI remain
required before merge.

The independent reviewer approved the final correction and independently
reproduced graceful lock-connection failure followed by successful reuse, with
no remaining blockers.
