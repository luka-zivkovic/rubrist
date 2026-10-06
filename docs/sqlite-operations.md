# SQLite installation and recovery

**TARGET:** one API instance on one host, durable local storage, and the same
application features as PostgreSQL. **CURRENT:** Milestone 5 implementation is
under qualification; no SQLite release has been published by this work.
Commands below require a release that includes these tools and templates.
Do not use the historical 0.3.0 image with the new template's `/ready` check.

## Install either backend

Choose `sqlite` or `postgres` once. The template configures all persistent
accounts, sessions, evidence, credentials and jobs. There is no runtime fallback
or database conversion. Run the installer from the matching release image
(replace `X.Y.Z` with its exact published version):

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/out" \
  --entrypoint node ghcr.io/luka-zivkovic/rubrist-api:X.Y.Z \
  tools/self-host/install.mjs --backend sqlite --version X.Y.Z \
  --directory /out/rubrist-install --public-url http://localhost:8081
cd rubrist-install
docker compose up -d --wait --wait-timeout 900
```

The directory must not exist. The installer writes a unique Compose project
name, the selected `compose.yaml`, `.env`, and `auth-recovery.json`. Files are
private and secrets are generated from 32 random bytes. Keep that project name
unchanged during updates: it names the volumes. Save the recovery record in a
separate protected off-host secret store before using the instance. The installer
only prepares files; it does not launch or update Docker or create trustctl state.
Source users can run the same script with Node 24.15 or newer from the matching
checkout. A public TLS URL is recommended when exposing the installation; the
web port binds loopback by default.

Open the web URL and create the first owner. Connect a harness through the
existing agent setup flow or create a project API key. Author an evaluator and
run an evaluation through the existing API/UI. Backend selection is not a UI
setting. The SQLite template contains no PostgreSQL service or connection URL.

The API runs as root inside the current image; SQLite files are 0600. Preserve
volume ownership. A future non-root image requires an explicit ownership
migration, not simply changing `user:` on a populated volume.

## Health and storage

- `/health` is HTTP liveness and never reads auth or storage.
- API `/ready` requires a bounded storage round trip and every expected queue
  handler with recent polling progress. SQLite's storage probe commits a small
  command-clock write, so it detects write failures. It has a two-second response
  deadline and at most one underlying probe in flight. A poisoned queue is
  logged as degraded; the poll loop can remain ready while it retries. Readiness
  does not promise provider connectivity, successful jobs, or scheduled-task
  completion. Scheduled tasks are registered before the listener starts.
- `/ready` is internal to the API container; nginx exposes `/health`.
- The SQLite template requires an existing mounted local data directory and
  rejects the container writable layer and tmpfs. Do not use network filesystems
  or share a database across hosts. The runtime holds a separate OS-backed SQLite
  lock per database file; a second API fails startup. A crash releases that lock.
- Unexpected storage-worker exit terminates the API so Docker can restart it.
  Startup logs classify permission, disk-full, I/O, contention and schema errors
  without printing paths, SQL or credentials. Inspect `docker compose logs api`.
- Shutdown disables readiness immediately, stops pollers and queue claims, and
  drains HTTP and jobs concurrently. The container allows 45 seconds; the app
  forces exit after 30. An interrupted dispatched model call can become
  `outcome_unknown`; recovery does not promise exactly-once external calls.

Named volumes survive container replacement. They are not backups. Never run
`docker compose down -v` against an installation you intend to retain.

## Back up a running SQLite installation

Run maintenance inside the same API image/container, where the database uses
native local filesystem locks. Do not copy an active main database file alone.
The backup API captures committed WAL content through a separate read-only
connection. The private snapshot is converted to a self-contained database,
checked for integrity, foreign keys and exact migration history, and fsynced.
The completed manifest is written last; a directory without its manifest is an
incomplete backup. Existing output directories are never reused or overwritten.

```sh
# Transfer the protected recovery record to a temporary container path.
docker compose cp auth-recovery.json api:/tmp/rubrist-auth-recovery.json
docker compose exec -T api node tools/storage/sqlite-backup.mjs backup \
  --source /var/lib/rubrist/rubrist.sqlite \
  --output /var/lib/rubrist-backups/before-upgrade \
  --recovery-file /tmp/rubrist-auth-recovery.json
docker compose cp api:/var/lib/rubrist-backups/before-upgrade ./before-upgrade
docker compose exec -T api rm /tmp/rubrist-auth-recovery.json
```

Use a fresh output name every time. The recovery record must match the API's
actual `BETTER_AUTH_SECRET`. A domain-separated HMAC fingerprint binds the
manifest to it without exposing the encryption key. The secret is deliberately
absent from database backups and is needed to decrypt provider/integration
credentials and preserve session signatures. Do not rotate it during an update.
For an existing or Coolify installation, create a record without printing it:

```sh
docker compose exec -T api node tools/storage/sqlite-backup.mjs recovery \
  --output /tmp/rubrist-auth-recovery.json
docker compose cp api:/tmp/rubrist-auth-recovery.json ./auth-recovery.json
```

Move encrypted copies of backups off-host, separately from recovery secrets.
The backup volume on the application host cannot protect against host loss.
Scheduling and off-host retention are operator responsibilities. Monitor task
exit status and perform restore drills; a successful copy is not a restore drill.

## Restore into a new installation

Stop the original stack before starting its replacement. Running both copies
can repeat integration polling and external feedback writes. Keep the old volume
untouched until recovery is verified.

Prepare a fresh directory with the recovered secret, using the installer command
above plus `--recovery-file /out/auth-recovery.json` (place that protected file in
the mounted parent). Copy the backup directory into the new installation folder.
Do **not** start the new API before restoring. From the new installation folder:

```sh
docker compose run --rm --no-deps \
  --volume "$PWD/before-upgrade:/restore:ro" \
  --volume "$PWD/auth-recovery.json:/run/auth-recovery.json:ro" \
  api node tools/storage/sqlite-backup.mjs restore \
  --backup /restore --target /var/lib/rubrist/rubrist.sqlite \
  --recovery-file /run/auth-recovery.json
docker compose up -d --wait --wait-timeout 900
```

Restore checks the **target container's actual secret**, recovery fingerprint,
file checksum, integrity, foreign keys and compatible migration prefix. It copies
into a private temporary file and atomically links it to a new target. Any
existing target, WAL, SHM or journal file causes refusal. It never migrates or
overwrites an active database. Startup applies forward migrations. Verify login,
harness authorization, retained receipt/artifact bytes and a synthetic evaluation
before reconnecting production integrations.

A backup captures state at one point in time. Later writes are absent. Restoring
a backup taken before erasure or key purge can restore those records and remove
later tombstones. Reapply post-backup erasures before accepting new ingestion;
retain backups only for the required recovery window. This limitation also
applies to PostgreSQL dumps. Carrying erasures across snapshots is separate work.

## Upgrade and rollback

SQLite migration history is forward-only from the first SQLite release. Applied
files and checksums are preserved. Take a verified backup before changing image
versions. Move the exact image version and its matching Compose template together,
retaining `.env`, the project name, data volume and auth secret. Run
`docker compose up -d --wait --wait-timeout 900`, inspect logs/readiness, and verify
a synthetic evaluation. Release notes must say whether SQLite migrations changed.

An older image refuses a newer or divergent schema. If migrations changed,
rollback requires stopping the new image and restoring its **pre-upgrade** backup
into a new location before running the old image. Writes since the backup are
lost. PostgreSQL keeps its separate accepted baseline policy and upgrade rules;
SQLite installations are not reset when a PostgreSQL baseline changes.

## Coolify and trustctl

Use `deploy/coolify.sqlite.yaml` with its matching image version. Coolify generates
the auth/bootstrap secrets. Save the auth secret via the recovery command above
or a protected secret manager. Keep one API replica. The separate data and backup
volumes are local to the host. For restore in an existing Service, stop it, restore
into a new filename under `/var/lib/rubrist` using the same image and recovered
secret, then set `RUBRIST_SQLITE_PATH` to that absolute filename and redeploy.
Never replace the existing database or its sidecars. Custom scheduling is required;
this recipe does not claim Coolify's database backup feature covers SQLite.

The independently maintained **trustctl v0.2.0 supports PostgreSQL only**. It fetches
`compose.yaml` and its checksum, requires a PostgreSQL password and does not
implement backups or restore. SQLite uses `compose.sqlite.yaml` with its own
checksum and the one-time installer/manual workflow. No trustctl code or state
is changed here. Coolify Services retain their own saved configuration.

## Backup access and evidence governance

A backup contains sealed material, blind-review content, private calibration
ledgers, governed truth, production feedback, password hashes, sessions and
encrypted credentials. Reading it is database-administrator access **outside
application exposure accounting**, just like a PostgreSQL dump. Restrict access
and use encrypted off-host storage. Restoring does not weaken the managed
connection's validators: the recovery drill must still reject forged evidence,
immutable-record updates and incomplete bundles, and retain exact artifact bytes.
