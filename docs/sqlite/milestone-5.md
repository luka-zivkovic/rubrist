# Milestone 5: installation and operations

**CURRENT (2026-10-06):** implementation, independent audits and complete local
qualification pass. At the user's instruction, an independent Claude Code review
replaced Copilot review for this PR. Corrections passed independent audit and
Claude follow-up; PR CI and integration of the remaining M4 corrections are
pending. This is not a published release or an
authorization to deploy an existing installation.

The two fixed templates select PostgreSQL or SQLite for all state. SQLite has
one API, a local persistent data volume and a separate backup volume. The
one-time installer supports either template, private CSPRNG secrets, a unique
Compose project name, recovered-secret input, and exclusive fresh-directory
creation. PostgreSQL retains its original asset name and trustctl v0.2.0 path.
Coolify has separate recipes. API startup grace covers migrations; shutdown
allows the existing application deadline.

Readiness performs a bounded, coalesced storage probe and checks all registered
queue workers. The SQLite probe writes the command clock; the poller advances
through degraded queues while logging failures. Liveness does not read storage
or authentication. Production startup holds a process-lifetime OS SQLite lock,
rejects database/lockfile symlinks (including dangling links), and requires a
persistent mount when the template selects that check. Unexpected storage-worker
exit terminates the API for Docker recovery. Shutdown marks readiness false,
drains HTTP and scheduled tasks, then stops the queue and storage.

The maintenance CLI uses a pinned read snapshot and SQLite's native backup API,
verifies integrity, foreign keys and exact running-image migration history,
then writes a manifest last in an exclusively created private directory. Restore
verifies copied bytes, compatible history, recovery-secret HMAC and the target
installation's actual secret; it publishes only to a new path with no sidecars.
Application startup migrates forward. The recovery record is deliberately separate
from the backup. [Operator instructions](../sqlite-operations.md) cover setup,
backup, restoration, upgrade, rollback, custody and erasure limitations.

## Claude Code consultation

CURRENT: Claude Code reviewed the architecture through agent-bridge and found
no additional ADR required for this shape. Adopted findings include unique
Compose project names, a persistent-volume guard, runtime singleton ownership,
secret matching on restore, a domain-separated HMAC fingerprint, queue progress
semantics, startup grace, worker-failure exit, concurrent drain, and explicit
backup-custody/erasure documentation. Existing accepted forward-only SQLite
history remains preserved; PostgreSQL's baseline policy is unchanged. No new
product decision or evidence contract was introduced.

Claude's backup experiment used Node 22. A real Node 24.21 container rejected
its proposed negative backup rate. The implementation instead pins an explicit
read snapshot and uses a supported positive page rate, verified on local Node
24.15/SQLite 3.51.3 and container Node 24.21/SQLite 3.53.4. Container Node images
are pinned by version and manifest digest.

## Claude Code PR review

CURRENT: Claude Code reviewed exactly `fda3f95..9eb3a4c` read-only and found no
Blocker/High issue. The following corrections were committed in `cb9bb01`
and independently audited:

- Shutdown is staged again: HTTP and poller drains (at most 15 of the 30
  seconds) finish before the queue closes pg-boss's send path, and queue,
  PostgreSQL pool and SQLite cleanup each still run when an earlier step
  rejects or times out.
- PostgreSQL and Coolify docs require templates from the release tag matching
  `RUBRIST_VERSION`; the current `/ready` templates need the first release that
  serves it, and `0.3.0` keeps its `v0.3.0` templates.
- The documented Compose restore is the helper-container procedure the drill
  runs. Coolify gained explicit backup/restore commands derived from the
  selected container's mounts and environment; those are **not** drilled.
- Coolify PostgreSQL has the same 45-second stop grace; the recovery-record
  snippet removes the container copy.
- The installer refuses a `--version` other than its own release; drills and
  fixtures use the package version.
- The unverified SQLite template checksum is resolved by the authorized
  dependent Milestone 6 PR #198 release workflow, which checks and renders both
  templates; it is not duplicated here.

Correction evidence (Node 24.15.0, `maxWorkers=1`): the API typecheck passes;
focused staged-shutdown, readiness, restore-boundary and route-manifest tests
pass 16/16; operations tooling tests pass 4/4. After merging M3 `aefad36`,
Claude independently reviewed merge `14cdd14`: typecheck and 24/24 focused
tests passed, with no runtime blockers. Three follow-up documentation findings
were corrected: private restore-environment permissions, explicit backup and
container selection in a fresh shell, and a distinct recovery installation
directory.

Independent container requalification of `14cdd14` built API image
`9f51a7a963c4`: both SQLite and PostgreSQL installation/restart/replacement
drills passed; SQLite backup and fresh-volume restore preserved exact receipt
bytes. The documented in-image installer passed for both backends and for a
fresh recovery installation with the original secret and private files.
Coolify itself, the full suite and benchmarks were not repeated in this check.
The earlier qualification below remains historical evidence for its pinned image.

A subsequent independent audit found calibration discovery also needed to drain
before queue shutdown. Its stop handle now waits for the active discovery pass.
Claude verified three new regression tests (including failures without the fix),
typecheck and 41 focused tests; one unrelated PostgreSQL-only test was skipped.
The independent follow-up passed all seven shutdown tests. Backup tests now
verify every current migration name and checksum, avoiding a stale fixed count.

After merging the Milestone 4 corrections (`137deee`, migrations 0066–0068),
Claude implemented option A of M4 finding M4-6: detection of a persisted SQLite
command clock ahead of host time. The worker reports the persisted lead at
startup (a plain read) and on each readiness probe (from the probe's existing
managed command). A process-local monitor logs one `rubrist.storage.clock`
warning per episode above a 60-second tolerance and one notice on catch-up.
It never fails startup or readiness and never rewinds, caps or reformats
timestamps; the product decision on in-band clock repair remains open. Claude
also confirmed the merged calibration worker keeps the discovery drain and that
root's dynamic migration-history backup assertion matches 0001–0068.
Evidence (Node 24.15.0, `maxWorkers=1`, no build or containers): API typecheck
passes; 13 focused files pass 93/93, including three new clock tests whose
de-duplication and startup assertions failed under mutation; operations
tooling tests pass 4/4. The container drills predate this diagnostic.

## Validation record

CURRENT focused evidence:

- Independent readiness and queue audit: 18/18 tests, including PostgreSQL
  worker predicates, queue degradation, singleton exclusion/release, symlinks,
  worker death, bounded probes and shutdown races.
- Independent backup/installer audit: 3/3 tests. Valid-checksum corrupted schema
  artifacts reach migration verification, cleanup leaves no target/temp residue,
  mismatched secrets and stale sidecars fail, and recovery-env quoting rejects
  unsupported trailing backslashes before creating a file.
- Independent restored-evidence audit: exact calibration bytes and encrypted
  credentials survive; plain validator writes fail closed; managed immutable
  artifact writes fail; omitted activation finalization rolls back before a
  valid activation succeeds.
- Disposable SQLite containers, PostgreSQL absent: first owner, session login,
  harness API key, mock evaluation, exact receipt retrieval; restart and fresh
  volume restore preserve the same session, key and receipt bytes.
- Final pinned image `56cd8d2c915d`: PostgreSQL installation/restart/replacement
  passed; SQLite installation/restart/replacement/backup/fresh-volume restore,
  newer-schema refusal, synthetic predecessor upgrade and old-backup rollback
  passed. Both smoke scripts also passed with deliberately conflicting parent
  Compose settings; explicit project/files and a filtered environment isolate
  every operation and cleanup to disposable resources.
- Workspace typecheck, complete build, shared contracts, repository boundaries,
  57/57 tooling tests and diff checks pass. The large-file report exits cleanly
  but identifies four pre-existing unclassified files; classification is tracked
  in Milestone 6. Full regression first passed 2,842 tests with two stale route
  snapshot failures; the corrected public-health/readiness ordering passes its
  independent 4/4 rerun. The final clean full suite passed **2,844/2,844 tests
  in 361 files, zero skips, plus 57/57 tooling tests**.

The generic installer is also embedded in the exact API image. Host Node is an
optional source-checkout path. The full container smoke script owns only fresh
randomly named projects/volumes and synthetic data; it does not contact real
providers or existing installations. Its optional predecessor is explicitly a
synthetic image omitting the newest migration, not a historical SQLite release.
