# Settings clarity

Founder-authorized settings refactor, 2026-09-29. Vocabulary mapping,
integration features and retention-policy changes remain outside this slice.

TARGET: account and project ownership are clear, forms are consistent, and
consequences match the existing server behavior. PRODUCT.md, ADR-0011's hosted
preservation exception and ADR-0013's separate production-record erasure remain
binding. No migrations, model calls or hosted destructive QA are required.

CURRENT before this change: owner-only actions render for members; dashboard
role information is unavailable without a selected criterion; provider mutations
share an unsafe single busy string; retention describes a nonexistent nightly
trace sweep and promises verdict preservation despite eligible-case cascades.

## Contract and fixtures (before implementation)

GET /api/project/settings adds a required viewerRole (owner/member) transport
field, separate from persisted ProjectSettings. It resolves authenticated project
membership without looking up an evaluator or criterion. Missing identity or
membership fails closed. Demo returns owner for transport consistency, while
its settings UI is explicitly read-only. PATCH and mutation authorization stay
unchanged. Invalid/missing access metadata is a load error, never owner access.

| State | Positive fixture | Negative fixture |
| --- | --- | --- |
| Owner, no criterion selected | Project-scoped settings editable | No dependency on dashboard or evaluator |
| Member | Project/provider metadata readable; account sign-out available; API key list remains owner-only | No project mutation controls |
| Demo | Settings readable with demo explanation | No failing credential/delete forms |
| Settings/role request fails | Retryable error | No default owner permission |
| Clean/dirty retention | Saved period shown, Save and Discard for changes | No pruning with an unsaved period |
| Invalid retention | Associated validation error | No API mutation |
| Save pending/fails | Inputs/actions guarded; draft retained on failure | No stale successful status beside a new draft |
| Delete expired traces | Explicit confirmation naming saved period and deleted data | No claim that all verdicts remain or nightly pruning exists |
| Provider mutation pending | Card mutations serialized, stable draft snapshot | No second request or stale row busy state |
| API revoke/purge pending | Duplicate action prevented and scoped feedback | No incorrect agent instructions for ingest-only keys |
| Dirty page navigation/refresh | Confirm discard; cancel retains draft | No silent loss of typed settings or credentials |
| One-time created key | Visible only in current component memory; uncopied key guards navigation until copy or explicit Hide | No persistence/logging of plaintext |
| Cancelled project switch | Stored project and API request header remain on visible project | No cross-project write after cancelled unload |
| Pending sign-out | Project and credential controls frozen; failure restores drafts | No mutation started before session reload |
| Project deletion | Existing name confirmation and server authorization | No destructive hosted QA |

CURRENT implementation target for this batch: one Settings route with Project,
Connections and Your account sections. Evaluator configuration remains on its
versioned Review guide surface; integration configuration remains in Integrations.
Local disclosures hold advanced setup. A required role in the GET transport
response is UI metadata, not a replacement for authorization on every mutation.

Verification: interaction and contract tests, existing server denial/retention
preservation tests, full local and PostgreSQL CI suites, typecheck/build/guards,
independent exact-diff review, then read-only hosted browser and data comparison.

CURRENT verification before PR: full local suite passed (1,968 tests, 159
PostgreSQL-only tests deferred to CI), 34 tool checks, typecheck, production build,
repository boundaries and shared-contract guards. Review fixes add three
interaction cases for a cancelled project switch, pending sign-out and uncopied
key loss. Local browser fixtures cover owner/member states, mobile overflow,
retention save without deletion and credential-draft navigation cancellation;
all mutations in that browser run use local fixtures.
