# SQLite installation and recovery

**TARGET:** one API instance on one host, durable local storage, and the same
application features as PostgreSQL. **CURRENT:** Milestone 5 implementation is
under qualification; no SQLite release has been published by this work.
Commands below require the first release that includes these tools and
templates; none is published yet. Always use an image and template from the
same release. The legacy `0.3.0` image serves no `/ready` route and has no
SQLite tooling; use its `v0.3.0`-tagged templates instead.

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

`--version` must equal the release of the image (or checkout) that runs the
installer; any other value is refused, because the template comes from that
release. CURRENT qualification runs this container installer for both backends
and verifies a fresh recovery installation preserves the original secret.
These checks use a locally rebuilt candidate image; no release is published.

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
- Shutdown disables readiness immediately, then drains HTTP requests and
  scheduled pollers together for at most 15 seconds, because both can still
  enqueue jobs. Only then does it stop the queue (draining claimed jobs) and
  close storage. The container allows 45 seconds; the app forces exit after 30.
  An interrupted dispatched model call can become
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
# Transfer the protected recovery record to a temporary container path;
# run the final rm even if the backup fails.
docker compose cp auth-recovery.json api:/tmp/rubrist-auth-recovery.json
docker compose exec -T api node tools/storage/sqlite-backup.mjs backup \
  --source "$(docker compose exec -T api printenv RUBRIST_SQLITE_PATH)" \
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
For an existing installation, create a record without printing it, then
remove the container's temporary copy:

```sh
docker compose exec -T api node tools/storage/sqlite-backup.mjs recovery \
  --output /tmp/rubrist-auth-recovery.json
docker compose cp api:/tmp/rubrist-auth-recovery.json ./auth-recovery.json
docker compose exec -T api rm /tmp/rubrist-auth-recovery.json
```

Run the `rm` even if a copy step fails. Coolify uses the container commands in
[Coolify backup and restore](#coolify-backup-and-restore).

Move encrypted copies of backups off-host, separately from recovery secrets.
The backup volume on the application host cannot protect against host loss.
Scheduling and off-host retention are operator responsibilities. Monitor task
exit status and perform restore drills; a successful copy is not a restore drill.

## Restore into a new installation

Stop the original stack before starting its replacement. Running both copies
can repeat integration polling and external feedback writes. Keep the old volume
untouched until recovery is verified.

From the parent of the original installation, prepare a different directory
with the recovered secret. Use the release image you intend to restore; for
rollback, use the older matching release image and version. Keep the recovery
record private and copy the selected backup into the new installation:

```sh
umask 077
cp rubrist-install/auth-recovery.json ./auth-recovery.json
chmod 600 ./auth-recovery.json
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/out" \
  --entrypoint node ghcr.io/luka-zivkovic/rubrist-api:X.Y.Z \
  tools/self-host/install.mjs --backend sqlite --version X.Y.Z \
  --directory /out/rubrist-restored --public-url http://localhost:8081 \
  --recovery-file /out/auth-recovery.json
cp -R rubrist-install/before-upgrade rubrist-restored/before-upgrade
cd rubrist-restored
```

Do **not** start the new API before restoring. Copy the backup and recovery
record into a temporary helper container that mounts the new installation's
volumes, then restore inside it:

```sh
helper="rubrist-restore-$(date +%s)"
docker compose run -d --no-deps --name "$helper" api sleep infinity
docker cp ./before-upgrade "$helper":/restore
docker cp ./auth-recovery.json "$helper":/run/recovery.json
docker exec "$helper" node tools/storage/sqlite-backup.mjs restore \
  --backup /restore --target /var/lib/rubrist/rubrist.sqlite \
  --recovery-file /run/recovery.json
docker rm -f "$helper"
docker compose up -d --wait --wait-timeout 900
```

The helper deliberately avoids host bind mounts: a bind of a temporary host
path failed under Colima during qualification, while `docker cp` works on any
local Docker engine. Its writable layer holds copies of the backup and recovery
record, so run `docker rm -f "$helper"` even when the restore fails. This is
the procedure the disposable SQLite drill runs.

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

Use `deploy/coolify.sqlite.yaml` from the release tag that matches its image
version. Coolify generates the auth/bootstrap secrets. Keep one API replica. The
separate data and backup volumes are local to the host. Custom scheduling is
required; this recipe does not claim Coolify's database backup feature covers
SQLite.

### Coolify backup and restore

Run these commands on the Coolify host from a private working directory. They
are written for this recipe but have **not** been exercised against a Coolify
Service; the qualified drill uses the Compose installation above. Identify the
Service's API container yourself rather than relying on Coolify naming or labels:
list running API containers, pick the one Coolify shows for this Service, and
confirm which volumes are actually mounted into it. Start a dedicated shell
with `bash` before pasting these blocks: a failed `|| exit 1` check then ends
only that shell, not your login session, and later blocks reuse its variables.

```sh
umask 077
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep rubrist-api
api=CONTAINER_NAME_FROM_THE_LIST
docker inspect --format '{{range .Mounts}}{{.Type}} {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}} -> {{.Destination}}{{println}}{{end}}' "$api"
source_path="$(docker exec "$api" printenv RUBRIST_SQLITE_PATH)"
```

The output must show `/var/lib/rubrist` and `/var/lib/rubrist-backups` mounts.
Create the recovery record once, without printing the secret:

```sh
docker exec "$api" node tools/storage/sqlite-backup.mjs recovery \
  --output /tmp/rubrist-auth-recovery.json
docker cp "$api":/tmp/rubrist-auth-recovery.json ./auth-recovery.json
docker exec "$api" rm /tmp/rubrist-auth-recovery.json
```

Back up the running Service. Always remove the container's recovery copy,
including after a failed backup:

```sh
umask 077
name="backup-$(date -u +%Y%m%dT%H%M%SZ)"
docker cp ./auth-recovery.json "$api":/tmp/rubrist-auth-recovery.json
docker exec "$api" node tools/storage/sqlite-backup.mjs backup \
  --source "$source_path" --output "/var/lib/rubrist-backups/$name" \
  --recovery-file /tmp/rubrist-auth-recovery.json
docker exec "$api" rm /tmp/rubrist-auth-recovery.json
docker cp "$api:/var/lib/rubrist-backups/$name" "./$name"
```

To restore, first capture the image, the data mount and the Service's **actual**
auth secret from the API container while it still exists. The secret goes only
into a private `--env-file`; it is not printed or placed on a command line:

```sh
umask 077
api=CONTAINER_NAME_FROM_THE_LIST
name=BACKUP_DIRECTORY_TO_RESTORE
test -f "./$name/manifest.json" || exit 1
image="$(docker inspect --format '{{.Config.Image}}' "$api")"
data_mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/rubrist"}}{{if eq .Type "volume"}}type=volume,src={{.Name}}{{else}}type=bind,src={{.Source}}{{end}},dst=/var/lib/rubrist{{end}}{{end}}' "$api")"
test -n "$data_mount" || exit 1
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$api" \
  | grep '^BETTER_AUTH_SECRET=' > rubrist-restore.env
chmod 600 rubrist-restore.env
test "$(wc -l < rubrist-restore.env)" -eq 1 || exit 1
```

Stop the Service in Coolify. `docker inspect --format '{{.State.Running}}' "$api"`
must not print `true`. Then restore into a **new** filename on the same data
volume through a helper that never starts the API:

```sh
target="/var/lib/rubrist/rubrist-restored-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
helper="rubrist-restore-$(date +%s)"
docker run -d --name "$helper" --env-file rubrist-restore.env \
  --mount "$data_mount" --entrypoint sleep "$image" infinity
docker cp "./$name" "$helper":/restore
docker cp ./auth-recovery.json "$helper":/run/recovery.json
docker exec "$helper" node tools/storage/sqlite-backup.mjs restore \
  --backup /restore --target "$target" --recovery-file /run/recovery.json
docker rm -f "$helper"
rm rubrist-restore.env
echo "$target"
```

Run `docker rm -f "$helper"` and `rm rubrist-restore.env` even when a step fails.
Restore refuses a backup whose recovery record does not match the Service's
secret. Set the Service's `RUBRIST_SQLITE_PATH` to the printed absolute filename
and redeploy. Never replace the existing database or its sidecars; keep it until
the restored Service is verified as described above.

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
