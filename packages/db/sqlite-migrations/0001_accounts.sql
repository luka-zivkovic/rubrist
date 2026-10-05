-- SQLite account-stage schema. No evaluator/evidence tables or demo fixtures.
-- Better Auth 1.6.22's SQLite adapter stores date fields as ISO text.
CREATE TABLE "user" (
 id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)), image TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE session (
 id TEXT PRIMARY KEY NOT NULL, expires_at TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ip_address TEXT, user_agent TEXT,
 user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX session_user ON session(user_id);
CREATE TABLE account (
 id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at TEXT,
 refresh_token_expires_at TEXT, scope TEXT, password TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(provider_id,account_id)
) STRICT;
CREATE INDEX account_user ON account(user_id);
CREATE TABLE verification (
 id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT, updated_at TEXT
) STRICT;
CREATE INDEX verification_identifier ON verification(identifier);
CREATE TABLE organizations (
 id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE organization_members (
 id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('owner','member')),
 created_at TEXT NOT NULL, UNIQUE(organization_id,user_id)
) STRICT;
CREATE TABLE projects (
 id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 mode TEXT NOT NULL DEFAULT 'tracing' CHECK(mode IN ('bench','tracing')),
 trace_provider TEXT NOT NULL DEFAULT 'manual',
 trace_retention_days INTEGER CHECK(trace_retention_days > 0),
 imported_trace_count INTEGER NOT NULL DEFAULT 0 CHECK(imported_trace_count >= 0),
 auto_judged_trace_count INTEGER NOT NULL DEFAULT 0 CHECK(auto_judged_trace_count >= 0),
 sync_back_coverage REAL NOT NULL DEFAULT 0 CHECK(sync_back_coverage BETWEEN 0 AND 1),
 setup_state TEXT NOT NULL DEFAULT 'unconfigured' CHECK(setup_state IN ('unconfigured','configured')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(id,organization_id)
) STRICT;
CREATE TABLE project_members (
 id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('owner','member')),
 created_at TEXT NOT NULL, UNIQUE(project_id,user_id)
) STRICT;
CREATE INDEX project_members_user ON project_members(user_id,created_at);
CREATE TABLE invitations (
 id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
 email TEXT NOT NULL COLLATE NOCASE, token_hash TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL CHECK(role IN ('owner','member')),
 invited_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
 expires_at TEXT NOT NULL, redeemed_at TEXT, redeemed_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(project_id,organization_id) REFERENCES projects(id,organization_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE api_keys (
 id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL,
 capability TEXT NOT NULL CHECK(capability IN ('judge','production_ingest')),
 created_by_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
) STRICT;
CREATE INDEX api_keys_project ON api_keys(project_id);
CREATE TABLE agent_setup_pairings (
 id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 created_by_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, claimed_at TEXT, consumed_at TEXT, revoked_at TEXT,
 created_at TEXT NOT NULL
) STRICT;
CREATE INDEX pairing_project ON agent_setup_pairings(project_id);
CREATE TABLE judge_provider_keys (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK(provider IN ('anthropic','openai','openrouter','custom','typesafe')),
 encrypted_credentials TEXT NOT NULL CHECK(encrypted_credentials LIKE 'aes-256-gcm:v1:%'),
 key_display TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,provider)
) STRICT;
CREATE TABLE audit_logs (
 id TEXT PRIMARY KEY NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
 actor_user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL, action TEXT NOT NULL,
 target_type TEXT NOT NULL, target_id TEXT NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata)), created_at TEXT NOT NULL
) STRICT;
