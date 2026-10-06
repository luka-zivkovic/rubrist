# Architecture

Rubrist is a TypeScript monorepo with a React web application, a Hono API, Postgres persistence, and pg-boss workers. It can also run against deterministic in-memory fixtures for local exploration.

## Documentation authority

This document describes current implementation architecture. `PRODUCT.md`
defines intended product scope, and accepted ADRs under `docs/decisions/`
define binding architectural decisions. When this document conflicts with
those sources, the charter and accepted ADRs win; the conflict is a
documentation or implementation gap rather than a change in product intent.

## Components

| Component | Responsibility |
| --- | --- |
| `apps/web` | Criterion selection, review, calibration, evaluator editing, datasets, integrations, and settings UI |
| `apps/api` | HTTP API, authentication boundaries, project authorization, repositories, and workers |
| `apps/audit` | Provider-independent structured judging and verdict validation |
| `packages/shared` | Zod domain models and transport contracts shared by API and web |
| `packages/db` | PostgreSQL migrations, SQLite migrations and demo fixture data |
| `packages/queue` | Queue names, pg-boss construction, and the SQLite durable queue adapter |

## Runtime modes

### Postgres mode

Setting `DATABASE_URL` enables persistent storage, Better Auth, project membership checks, migrations on startup, and background workers. This is the production-shaped runtime.

### Demo mode

In development, with no backend selector or database variables, the API uses `DemoRepository`. Explicit `RUBRIST_STORAGE=demo` also selects it; production requires an explicit selector or the legacy PostgreSQL URL. It contains representative fixtures and deterministic mock judging so the product can be explored without external services. Demo data is not persistent and authentication is disabled.

### SQLite development runtime

CURRENT: `RUBRIST_STORAGE=sqlite` and an absolute `RUBRIST_SQLITE_PATH` select
persistent Better Auth, accounts, projects, API keys, invitations, pairings
and encrypted provider credentials in one local file. `BETTER_AUTH_SECRET`
is required; `DATABASE_URL` must be absent. A serialized database worker owns
connections and separate checksummed migrations. Shared routing injects account
services rather than using a PostgreSQL pool for authorization. Malformed
configuration or storage failure never selects demo.

This development checkpoint requires Node 24.15+ and one application instance.
Native criteria, mutable collections, and batch evaluations use the same
repository contracts and shared evaluation workers. The SQLite queue persists
claims and retries; separate evaluation tokens fence provider dispatch and
completion. A terminal release-evidence run and its exact receipt BLOB commit
together. Interrupted dispatched calls become explicit uncertainty, never an
automatic second provider call. Worker transport revives BLOBs as Buffers.

Integration, revision, analysis, and governed workflows remain explicitly
unavailable. This is not a release installation option yet. See
[Milestone 2](sqlite/milestone-2.md) for the exact boundary and validation.

## Core flows

### Trace ingestion

CURRENT: accepted strings are retained without an implicit length cap. Explicit
integration caps still mark shortened strings; default read-side redaction
preserves retained length while scrubbing sensitive keys. Existing HTTP limits
are unchanged. Review surfaces warn when recorded evidence contains a truncation
marker. This does not restore old clipped text or revalidate historical results;
see [retained trace evidence](long-evidence.md).

1. A trace arrives through the manual endpoint, the judge API, LangSmith, Langfuse, or Ironside with an exact evaluator-version pin. Ironside supplies a settled remote trace-version identity and an opaque continuation cursor; Rubrist does not reproduce Ironside's settlement policy. Singleton projects may resolve the evaluator pin when the request is accepted; multi-criterion projects require it explicitly.
2. The raw provider payload is retained for auditability.
3. A normalized case is created with configured exclusions and sensitive-key redaction.
4. Automatic imports schedule durable evaluation runs over the supplied cases, reusing saved coverage where applicable.
5. The worker loads the exact skill version and its pinned provider binding.
6. The structured verdict, provider metadata, latency, and token usage are appended.

Scheduled integration configuration retains its evaluator pin. Pollers copy it
into the import job, and workers validate the pin's project ownership rather
than selecting a current evaluator when the job eventually runs. This keeps a
queue delay or later criterion edit from changing what the import measures.

CURRENT automatic import evaluation is scoped to the supplied cases, even for
the first import under a new evaluator. Existing-case evaluation remains an
explicit choice. First-assessment lookup filters version and run purpose before
limiting results; polling never creates a historical backfill when no saved run
is visible. See [import evaluation scope](import-evaluation-scope.md).

### Criteria and evaluator suites

A stable criterion owns one evaluator lineage. Criterion definition revisions
and evaluator versions are append-only; each evaluator version binds one exact
definition revision. Evidence queries, golden registries, regression snapshots,
review queues, agreement metrics, and trust artifacts carry that binding.
Legacy singleton selectors are compatibility surfaces only and return an
explicit ambiguity error once a project has several criteria.

An evaluator suite is a stable project-owned identity with append-only
manifest revisions. The canonical manifest bytes are the artifact of record;
relational member rows support ownership and execution checks. A manifest pins
ordered criterion definitions, exact evaluator versions, applicability, and an
optional independent-repetition plan. It cannot represent customer release
policy. The assessment receipt remains a separate artifact per criterion.

### Human review

Rubrist has two non-interchangeable review paths.

The governed path uses a dedicated session-authenticated repository and API.
Immutable instruction versions bind one criterion version. Server-selected
batches bind an exact population, selection plan, fixed stop, assignments,
capability checks, and state-machine version. Opaque reviewer tasks persist the
exact first-view canonical bytes; the allowlisted payload contains only
`input`, `output`, and optional `steps[{name?,input,output}]`. Task and batch
events, labels, alignment, and non-branching adjudications are append-only.
There is no majority vote. Missing coverage, `cannot_determine`, and
unresolvable adjudication remain incomplete.

Sealed intake uses a protected population and governed review items without
creating ordinary cases. It is unreachable through trace feeds, legacy queues,
project API keys, ordinary dataset reads, and verdict exports. Sealed reviewer,
alignment, and adjudication views never include evaluator output. Batch 4 can
freeze the resulting complete pass/fail truth revision. The current Batch 5B
runtime can execute one binary-evaluator trial over that exact case-less
revision and persist a separate aggregate-only calibration artifact. It does
not add evaluator evidence to any reviewer, alignment, or adjudication view.

The pre-existing verdict/review-queue path remains unblinded operational
triage. Human verdicts are appended rather than editing the judge verdict, and
historical adjudication does not delete disagreement. These APIs emit evidence
class `ungoverned_legacy`; they never become governed evidence. Agreement
diagnostics over this ledger keep undefined kappa explicit when expected
agreement is one.

CURRENT: saved queues can suggest ten cases from the newest 1,000 eligible
results for one exact evaluator version. The suggestion skips reviewed and
already-pending results, mixes flagged/ambiguous opinions, and reserves passing
spot checks. It shows selection reasons and any candidate cap, adds no provider
calls, and carries no representative or governed-selection claim. See
[the operational selection contract](review-prioritization.md).

CURRENT: saved review tasks created with `skillVersionId` pin both the evaluator
and a recorded judge-run ID: the latest at creation for manual lists, or the
explicit previewed result for suggested lists. Queue reads retain
that exact run across later evaluations. The UI requires an evaluator selection;
criterion-only API callers remain explicitly unpinned for compatibility, as do
preexisting tasks. Missing selected results fail without calling a provider.
Task reviews submit a queue item, displayed run and idempotency UUID; the server
validates ownership and assignment, derives the evaluator version, and appends
the ruling together with completion of only that task in one transaction.
Corrections append another attributed ruling. Ordinary case reviews do not
complete pinned tasks. Older unpinned tasks remain clearly labeled and retain
their historical records. Account erasure anonymizes historical actors and
unassigns pending tasks; those tasks still require a new explicit human review.
An internal stable assignment key prevents anonymization from colliding with an
existing unassigned task. The additive migration preserves the hosted benchmark
under the narrow exception recorded in ADR-0011. Retention skips cases with
pinned tasks or task-attributed human reviews and reports them separately, while
continuing to prune unrelated expired traces.

### Sealed binary calibration

In Postgres mode, an owner launches an explicit single-trial run bound to one
binary evaluator, criterion version, complete governed sealed-validation
revision, selection provenance, the evaluator's identity (definition digest
and execution binding), provider policy, and authorization/completion exposure
snapshots. The repository acquires a durable revision lease before execution.
The worker receives one protected payload without truth and runs it through
the executor, which sends exactly the pinned binding through its verdict
protocol in one physical call, with no retries and no parameter-changing
fallbacks (ADR-0014). A typed-question evaluator's attempt asks its question
through typed-question/v1 and records pass or fail on its threshold; it never
abstains (ADR-0014 section 5 and decision 8). Provider-call start is recorded durably after
every check that can refuse the call and immediately before dispatch, so a
refusal counts no call. The mock makes no call, so it can't be calibrated.

Creating a run is a governed gate (ADR-0014 sections 2 and 4). It needs a
resolved execution binding that states its reasoning, unless the resolution
shows the model rejecting that parameter itself, and states its temperature
wherever the model lets the author choose it (decision 12). An unresolved
binding resolves at the gate with up to four probes over a fixed,
non-sensitive input. A failed binding is fixed only by a new evaluator
version. Before a run's first authorization, and so before any sealed
exposure, the worker re-checks the binding with one to four probes: the
confirming probe again, the temperature probes where temperature is unset and
the record doesn't list the combination as ignoring it, and a reasoning probe
where reasoning is unset. A resolution that no longer holds, including
temperature 0 or 0.5 now accepted, rejects the run. A transient error leaves
the run waiting and retries after a back-off; it never fails the binding.
Every resolution attempt and re-check is appended against the gate, request,
or run that triggered it. The latest resolution is the version's record,
which is not identity. A stored record that doesn't parse under the current
rules, such as one from before decision 12 that probed temperature at 1,
reads as no record, so the binding resolves again.

Temperature is classified by outcome, never by a rejection's wording (ADR-0014
decision 12). A temperature probe sends 0, and 0.5 only where 0 was rejected,
with the reasoning being classified and the saved `topP` (none in the check),
and counts only where the same request without temperature was accepted: the
check's reasoning probe with that reasoning, or its protocol probe where no
reasoning fields are sent, and at resolution and the re-check the confirming
probe. 0 or 0.5 accepted is `adjustable`, and the gates then require an
explicit temperature; 0 and 0.5 both rejected is `not_adjustable`, and
temperature may stay unset, since the model sets it. An error leaves it
unknown, and no further temperature probe is sent. The dated
`rubrist-ignored-temperature/v1` table lists combinations that accept
temperature without applying it, each backed by the provider's own
documentation: DeepSeek's `deepseek-flash` and `deepseek-v4-pro` at
`https://api.deepseek.com` in thinking mode, reviewed on 2026-09-27. The
server matches an entry through the binding's endpoint digest, so a base URL
spelled differently doesn't match. For a listed combination the check,
resolution, and re-check send no temperature probe, the picker hides the
field, and the gates refuse a stated temperature. The record keeps the table
version and the entry that matched, and the gates and re-check read those,
never a newer table. `tools/temperature-study.mjs` reproduces the probes
behind the table; it makes live calls and is not run in CI. A failed binding
that stated a temperature carries a suggestion from the record's temperature
outcomes with the saved reasoning: leave temperature unset where 0 and 0.5
were both rejected, choose another value where one was accepted, and nothing
about temperature where it is unknown. Compatible authoring probes are now
carried into the record, so a rejected confirmation can retain the evidence
needed for that suggestion.

Resolution also runs after save: the gate worker confirms a newly saved
version's binding before its regression gate, with the confirming probe and,
where temperature is unset and the record doesn't yet classify it, up to two
temperature probes, so at most three calls (ADR-0014 section 4). It runs
only while the version has no record or an unresolved one, and never blocks
the gate; an attempt that can't finish leaves the binding unresolved until a
governed gate needs it. The in-memory demo runs its gate inline, without the
worker, so it skips resolution after save. Before save, an owner can run the
capability check (`POST /api/judge/capability-check`): up to 7 probes over
the same fixed input, with the credential and endpoint the saved binding
would use, derived as saving derives them, so a check never sends a key
anywhere a saved binding couldn't. It reports which protocol, temperature,
and reasoning the model takes, the documented default reasoning, the
reasoning with which the ignored-temperature table lists the model, and what
the provider publishes, within a 60-second budget, and says when it ended
early. The same route classifies temperature for reasoning the author selects
after the check (`classifyTemperature`): that reasoning without temperature,
unless the check already saw that request accepted, then the temperature
probes, so at most 3 calls. Its report classifies temperature only from
requests it sent itself; the picker reads its probes together with the
check's. Each owner may start 10 checks or
classifications a minute per project, and a project runs at most 2 at once.
CURRENT: checks are retained server-side for one hour. Project, endpoint,
model/version, routing, output limit, credential source, and actual credential
digest must match before reuse. A new full check supersedes older checks;
subsequent classifications extend it. Resolution selects bounded probes for
the saved protocol and settings, retaining conservative reasoning support and
the exact temperature classification. Unselected authoring probes remain only
in the expiring store; the resolution is not a total authoring-cost ledger.
It always sends a fresh confirmation, and governed re-checks never use this
cache. A check against a custom endpoint reaches the URL the owner
names, as the saved binding's calls would; restricting which hosts a custom
endpoint may name is not yet enforced (CURRENT).

In the model picker, temperature starts empty. The picker fills in 0 only
where the check saw 0 accepted with the selected reasoning, and empties a 0
it filled once that stops being so, for other reasoning or another model; a
value the author typed stays. Where it saw 0 rejected and 0.5 accepted, the
field stays empty, 0 is marked rejected, and the author states a value; a
value the check saw rejected is marked so even where its probes classify
nothing. Where 0 and 0.5 were both rejected, or the table lists the
combination, the field is hidden with the reason and nothing is sent. Where
no check could run, or its temperature probes ended in errors, the field is
shown empty and resolution decides the gate. A check sends no `topP`, so
where the draft carries over the base version's `topP`, the picker reads
temperature as unknown and resolution classifies it with that `topP`. When
the author selects reasoning the check didn't probe temperature with, the
picker classifies it; saving waits for that, and for a newly picked model's
check. A new check replaces the probes, so the picker drops a classification
still answering for the old one and asks again. First-project setup uses the
same picker, with detailed settings collapsed unless they need attention.
Choosing the first review focus starts the initial model check; creation waits
for pending checks and rejected settings to be addressed. Navigation and reload
warn before losing unsaved model choices (CURRENT).

The author sees a version's resolution on its version page and in the
evaluator lifecycle panel (`GET /api/evaluator-lifecycles/:id/resolution`):
the status, what the model showed about each setting the binding leaves
unset, every probe of the latest attempt with what it sent and how the model
answered, and whether the binding can pass a governed gate, with what to
change where it can't. A mutable model alias and the built-in mock are named
as the reason first, since the gates refuse them before reading resolution.
An owner can resolve on demand (`POST` on the same route) where resolving
could change the record; an alias is never probed (422), and a failed
binding stays failed. Resolution after save stores its record only where the
version has none or an unresolved one, so it never erases a fuller record a
concurrent resolution stored. The in-memory demo keeps no resolution
records, so it shows none.

Binary provider output is pass, fail, or ambiguous. Pass and fail are the two
classification outcomes; ambiguous is an explicit evaluator abstention. The
ordinary path routes it to needs-review/exception surfaces, while sealed
calibration records it as `abstained`, outside the confusion matrix.

An attempt terminalizes once. If a claim expires after durable call start but
before a terminal result, recovery records permanent `outcome_unknown`; it
does not recall the provider. Network work stays outside database
transactions. After all attempts terminalize, one repository transaction
rechecks exposure, derives aggregate statistics from the private salted
ledger, writes exact canonical public artifact bytes, and releases the lease.

The public artifact contains aggregate counts, metrics, confidence intervals,
the evaluator identity (never the rubric or prompt text), and requested and
observed provider provenance, including the OpenRouter upstream that served a
call. It contains no item identity,
protected payload, per-item truth or prediction, rationale, provider body, or
request/response identifier. The private ledger has no application, HTTP,
project-key, browser, analytics, CDC, debug, or operator-export read surface.
Current admissibility is served separately from immutable historical artifact
bytes, so later development exposure can revoke admissibility without
rewriting the artifact.

The frozen contract and conformance corpus cover repeated-trial artifacts, but
the current producer runtime accepts only
`{ kind: "single", trialsPerItem: 1 }`. Dailies has an independent local
contract verifier and consumes explicitly configured artifacts through its
suite configuration, release policy, suite report, runner, and CLI, and it
verifies the receipt and calibration artifacts Rubrist mints (Dailies
ADR-0008 and ADR-0010). It does not perform a network or latest-status
lookup.

### Governed Analyze populations and coding studies

Postgres mode assigns every ingested case an immutable analysis purpose before
it can enter a frame. An owner freezes one finite `[start,end)` database-time
population in a repeatable-read transaction. The revision stores exact frozen
payloads and pre-redaction input identities; resolved ineligible cases remain
separate exclusions. A structural identity registry prevents those nonsealed
inputs from racing into protected or final sealed evidence. The server then
uses one 32-byte seed and `sha256-rank/v1` to select a fixed-budget simple
random draw without replacement. One frame has one draw; a different budget
for the same frame conflicts instead of redrawing.

One immutable study may bind that draw. Opening freezes either an owner-close
rule or a server deadline. Study, item, taxonomy, view, closure, and assignment
events are append-only and compare-and-swap ordered. Owners and members may
code items and assign active observations; only owners administer study state
and taxonomy revisions. Payload reads are explicit, session-only, and record
both the existing governed revision exposure and a study-item view. Metadata
reads do not expose payloads.

At a deadline, state-changing requests first materialize the closure and then
fail; content remains readable and creates a post-close view excluded from the
stopped denominator. Closure atomically snapshots every selected item, active
observation and assignment head, and pre-close view. It recomputes the frozen
frame, verifies the persisted draw bundle and rank evidence, and persists the
one historical representative claim with a
closed negative reason when any gate fails. Taxonomy coverage is orthogonal to
that claim.

An owner can promote one current active failure code from the exact closure
into a reserved revision-1 criterion. The transaction binds the current
taxonomy head, every supporting observation and assignment head, and a complete
development-exposure fanout; it creates no evaluator or truth. The promotion
ID is an explicit nonsealed handoff accepted only by an analysis-authoring
governed batch for that exact criterion and analysis revision. That handoff and
analysis revision cannot enter generic dataset, iterative, or sealed source
branches; a separately created immutable iterative-development revision may
still use the promoted criterion through the existing nonsealed path.
Candidate creation is now an owner-session Analyze command over the exact
promoted criterion, frozen nonsealed governed batch, immutable truth revision,
and at least one resolved pass/fail item. The same transaction creates the
sole stable skill lineage when necessary, one immutable version (a prompted
rubric and prompt, or a typed-question question and decision threshold), a
copied known-failure regression revision, a durable developer exposure, and
the append-only `candidate` seed event. No legacy writer may mint a version on this
lineage without the complete bundle. Candidate creation and activation are
governed gates: they require a resolved execution binding with explicit
reasoning where the model takes it, and an explicit temperature where the
model lets the author choose it (ADR-0014 section 2 and decision 12),
resolved beforehand outside the transaction, and the candidate's resolution
becomes its version's record.

Lifecycle state overrides `skill_versions.status` for every
`analysis_promotion` lineage. Candidates and needs-review versions are allowed
only by exact reference in ordinary nonproduction dataset/governed evaluation
or the internal binary-calibration and retained-regression evidence contexts.
Implicit judging, imports, schedules, trace tests, release gates, and suite
publication require `active` plus the exact activation artifact to remain
currently admissible. Activation is owner-only and requires a complete
nonempty `passed` regression run over every retained item and exact complete
sealed calibration evidence. Revocation serializes with activation, appends
`needs_review`, and makes selectors fail closed before the next provider call.

Analyze measurements are a read-only, versioned projection over those exact
artifacts. The report always binds one study, population, draw, and frozen
revision; an optional taxonomy revision and evaluator version add exact
coverage/churn, governed disagreement, calibration, and duration components.
The primary disagreement buckets form a disjoint partition, while adjudication
is a separately named cross-cutting count. Calibration error directions and
Wilson coverage intervals are copied only from the named aggregate artifact;
the private ledger is not read. The historical first-completed duration is
immutable, while the first-currently-admissible duration is re-derived at read
time and may become missing after revocation. No component is combined into a
score or decision.

### Known-failure regression governance

Promoting or retiring a reviewed reference case advances an immutable
regression/golden revision. Creating a skill version pins the current revision
before queue dispatch; the queue payload carries that revision and the worker
cross-checks it against the version before re-judging the exact snapshot with
the version's pinned provider. Regression-run rows always retain that pin.
Drafts and starter versions approved by direct human sign-off are the only
version states that may have no regression binding. Later registry edits
cannot alter a run. A regressing
version remains in history and cannot replace the approved version unless an
owner records an explicit override reason. This is evaluator governance, not
customer release policy or representative accuracy.

The public collection-freeze path creates only analysis/authoring or iterative
development revisions. Regression/golden revisions require a golden snapshot,
and sealed validation is produced only through the current governed case-less
intake and blind-review path. Repeated run comparisons over byte-identical
collection evidence reuse one immutable revision so both evaluator runs remain
directly comparable without producing duplicate lineage rows.

### Dataset evaluation and CI

Datasets are named mutable working collections of cases with optional expected
labels. Freezing creates an append-only, content-identified revision with a
redacted payload snapshot and input-only exact identity per item. Ordinary eval
runs may bind either a working collection snapshot or an existing nonsealed
revision; bindings and exposure events are persisted with the run. Public
ordinary-collection sealed-validation creation remains unavailable. Sealed
revisions are produced only by the governed case-less intake and review flow,
never by upgrading visible historical data. See accepted [ADR-0002](decisions/0002-human-truth-and-dataset-revisions.md)
and [ADR-0007](decisions/0007-dataset-role-compatibility-and-exposure.md).

### Trace-derived tests

A trace-derived Test stores a complete redacted source snapshot plus the smaller
response/turn scope selected in the journey. Content edits append revisions;
validation attempts append evidence with a distinct operational-failure state.
Enabling appends a reviewed revision that points to a successful validation.
A later draft does not rewrite or disable the last enabled revision.

## Data and trust invariants

- Skill versions are immutable.
- Criterion versions and evaluator-suite manifests are immutable.
- One evaluator version measures exactly one criterion definition revision.
- Multi-criterion reads and writes require an explicit criterion/evaluator
  selection; unscoped evidence is never treated as a wildcard.
- Verdicts are append-only.
- On the legacy path, human labels outrank judge labels when a canonical
  triage label is required. Governed truth follows ADR-0008 resolution and
  adjudication rules instead.
- Golden cases are promoted explicitly by a person.
- Every judge result is attributable to a skill version and model binding.
- Infrastructure failures are never projected as judge failures or passing gate results.
- Missing evidence is represented as missing; trust metrics are not collapsed into a composite score.
- API keys and integration credentials are scoped to a project and never returned after creation.
- Trace-derived test revisions and validation attempts are append-only.
- Generated draft provenance never implies review or enablement; an enabled
  revision requires successful good/bad evidence and a recorded human reviewer.
- Governed and legacy human evidence never satisfy one another's contracts.
- Exact blind-view projection prevents named forbidden fields from crossing
  the API boundary; it does not establish semantic anonymity of arbitrary
  content.
- A representativeness claim is scoped to one exact finite frozen population
  and a complete qualifying random draw. Manual, systematic, convenience,
  uncertainty, and failure-hunting samples are nonrepresentative.
- Calibration artifact status/completeness is evidence state, never a customer
  threshold outcome or release verdict.
- Public calibration artifacts are aggregate-only and immutable. Their current
  admissibility status is separate and may change after later development
  exposure without changing historical bytes.
- A durable provider-call start is never retried after uncertain completion;
  recovery accounts it as `outcome_unknown`.
- Semantic clustering is deferred and supplies no Batch 4 sampling or truth
  claim.

## Authorization boundaries

CURRENT settings use Project, Connections and Your account sections. GET
`/api/project/settings` supplies a required session-scoped `viewerRole` alongside
persisted settings, without a dashboard/criterion lookup; missing access metadata
fails closed. Member and demo views are read-only. Trace retention saves the
period separately from confirmed manual deletion; production records retain
their separate controls. Credential changes serialize within each card. Drafts,
pending actions and uncopied one-time keys guard navigation, refresh and project
switching before the request's stored project pin changes. Sign-out freezes forms
until completion. Existing mutation authorization remains authoritative.

Session-authenticated `/api/*` routes resolve a project membership before accessing project data. Owner-only operations include invitations, credential management, retention changes, destructive project actions, gate overrides, and binary-calibration launch. `/api/v1/*` judge routes use project-scoped API keys instead of browser sessions. Binary-calibration artifact and current-status reads are an explicit exception to that path convention: they require a project-owner browser session and reject project API keys and member sessions.

## Database migrations

Rubrist currently supports clean installations only. PostgreSQL 17 is the
development and CI target, and `packages/db/migrations/0001_baseline.sql`
contains the complete current schema. The API serializes baseline application
under a database advisory lock, records its SHA-256 checksum, and rejects any
different or unknown migration history. Founder-only test databases are
recreated rather than upgraded when the baseline changes, as defined by
[ADR-0011](decisions/0011-prelaunch-blank-slate-database-policy.md).

`pnpm test:pg` creates one migrated template database in a disposable
PostgreSQL 17 container, clones a fresh database for each test, and deletes all
clones and the container after the run. CI provides an existing server via
`PG_SMOKE_DATABASE_URL`; without a prepared template, each database test uses
an isolated schema migrated from the same baseline.

### Workspace presentation

CURRENT: one sidebar inventory covers bench and tracing projects, including
saved review sessions in both. Old browser `rubrist.mode` values are ignored.
Raw IDs and model payloads use local disclosures. Project source mode, runtime
demo mode, and role authorization are unchanged. See the
[single-workspace contract](ux-audit/unified-workspace.md) for the narrow founder
authorization; ADR-0015's broader vocabulary and help layer remain proposed.
