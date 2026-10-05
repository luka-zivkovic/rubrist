# Milestone 1: persistent accounts on SQLite

CURRENT implementation checkpoint, 2026-10-05. Based on Milestone 0 commit
`d839575`. This is an account-stage development runtime, not a supported SQLite
product release. It does not implement evaluator execution or claim parity.
The accepted product/evidence contracts and PostgreSQL migration files are
unchanged; proposed ADR-0016 remains unresolved and is not needed by this slice.

## Runtime and migration boundary

CURRENT: `storage/config.ts` selects a fixed backend before opening storage.

| Configuration | Behavior |
| --- | --- |
| `RUBRIST_STORAGE=postgres` with `DATABASE_URL` | Existing PostgreSQL auth, migrations, repositories and workers |
| Legacy `DATABASE_URL` without a selector | Same PostgreSQL runtime |
| `RUBRIST_STORAGE=sqlite` with absolute `RUBRIST_SQLITE_PATH` | SQLite accounts and credentials; no PG pool or queue connection |
| `RUBRIST_STORAGE=demo`, without persistent database variables | Explicit in-memory demo |
| Development without any database variables or selector | Existing in-memory demo |
| Production without a selector or legacy PG URL | Startup error |

Empty, conflicting, missing or malformed persistent settings fail startup.
Both persistent backends require `BETTER_AUTH_SECRET`. There is no fallback
from a failed persistent backend to another backend or to demo. `createApp`
rejects persistent composition without both authentication and account services.
Shared routes use account services and the composed runtime's authentication
mode; a `Pool` is retained only at the PostgreSQL composition boundary.

SQLite requires Node 24.15 or newer (validated with Node 24.15.0 / SQLite
3.51.3). The database must live on durable local storage on the application
host. One application instance serves it; concurrent HTTP users are supported.
Multiple application instances sharing a file are outside the support boundary.
The parent directory must already exist and be writable. A separate worker
owns two connections, one for domain commands and one for Better Auth. It
serializes complete commands and async auth operations, keeping synchronous
SQLite work off the HTTP event loop and preventing requests from entering each
other's transactions. No model or integration network work is run in this worker.

Every connection configures and verifies foreign keys, recursive triggers,
WAL and FULL synchronous durability. Busy handling is installed before WAL
initialization; lock conflicts during initialization close the connection and
retry within a bounded five-second deadline. Files use mode 0600. Domain write transactions use BEGIN
IMMEDIATE and roll back on failure. Shutdown drains the worker's command queue
and closes both connections; a worker failure rejects subsequent operations.

`packages/db/sqlite-migrations/` has a separate, ordered, checksummed history
in `rubrist_sqlite_migrations`. An exclusive writer transaction owns validation
and application of the entire pending migration set. Failed migrations roll
back and can be retried. Unknown databases, changed applied SQL, missing
history entries and newer histories are rejected without resetting data.
Competing migration/open attempts are tested on fresh files. PostgreSQL's
applied migrations and checksums have not been rewritten.

## Account behavior

CURRENT: Better Auth uses the selected database for users, password accounts,
sessions and verification records. The browser's existing setup, sign-in,
sign-out and session-cookie routes are retained. Initial browser owner signup is
serialized across requests (a PostgreSQL advisory lock or a SQLite instance
queue). Workspace/project, membership and first API-key writes are atomic.
If the process stops after auth-user creation but before workspace creation,
the user can sign in and create a project through the existing project flow.
Recovery does not create a second auth user or reset existing accounts.

Project membership is required for project reads; owner checks cover settings,
credentials, invitations, API keys, deletion and pairing administration.
API keys, invitation tokens and pairing tokens are stored as hashes. API keys
retain capability restrictions and revocation. Invite redemption now checks
validity and matching email **before signup**, then rechecks under the backend's
transaction lock before one-time redemption. This also fixes the previous PG
route's invalid-token signup and concurrent redemption gaps.

Pairings retain their 15-minute token lifetime, 10-minute active-claim grace,
single claim, replacement/revocation protections and one-time completion.
The account-stage schema uses an explicit unconfigured project state; M2 must
replace that eligibility source with the real evaluator state when porting
onboarding. The agent bootstrap's evaluator/regression workflow is unavailable
in this milestone, so issuing a pairing is not a claim that full agent setup
can complete yet.

Provider credentials use the existing AES-256-GCM versioned envelope and
`BETTER_AUTH_SECRET` key derivation. The secret must remain stable across
restarts and backups. Tests verify encrypted-at-rest storage, redacted display,
restart retrieval and failure under a different secret. Integration connector
storage remains a later milestone; its encryption helper has not changed.
Project deletion preserves the existing audit actions and deleted-project
attribution while cascading account-stage project data.

## Development use and limits

After installing dependencies, create an empty local data directory and start
from source with **no DATABASE_URL in the environment**:

```sh
mkdir -p "$PWD/.sqlite-dev"
RUBRIST_STORAGE=sqlite \
RUBRIST_SQLITE_PATH="$PWD/.sqlite-dev/rubrist.sqlite" \
BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
pnpm dev:api
```

Save and reuse the generated secret for subsequent starts; the inline example
is only for a disposable first run. Keep the database and secret outside git.
For a persistent local setup, use a stable secret from your environment manager.
The API exposes `/health` and the existing auth/account endpoints. Account-stage
routes include project list/create/settings/delete, provider keys, API keys,
invitations and pairing administration. Authenticated requests to workflows
that need unported storage receive `503` with `sqlite_feature_unavailable`.
Unauthenticated requests still fail authentication first. Unsupported repository
methods fail explicitly; none return demo data or fabricated evidence.

The web login components remain unchanged, but dashboard, onboarding execution,
evaluation, integrations and evidence screens cannot operate on this account
checkpoint. Installation templates, complete UI parity, durable jobs, full
migration/backup operations and release qualification remain M2–M6 work.

See [validation and independent review](milestone-1-validation.md).
