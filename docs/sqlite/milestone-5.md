# Milestone 5: installation and operations

**CURRENT (2026-10-06):** implementation and focused independent audits pass;
full regression, container upgrade drill and PR checks are still running. This
is not a published release or an authorization to deploy an existing installation.

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
exit terminates the API for Docker recovery. Shutdown marks readiness false and
drains HTTP/jobs while stopping scheduled tasks.

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
- API typecheck, repository boundary guard and diff checks pass. Full-suite,
  final container and release validation will be recorded before the PR opens.

The generic installer is also embedded in the exact API image. Host Node is an
optional source-checkout path. The full container smoke script owns only fresh
randomly named projects/volumes and synthetic data; it does not contact real
providers or existing installations. Its optional predecessor is explicitly a
synthetic image omitting the newest migration, not a historical SQLite release.
