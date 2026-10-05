# Milestone 2 validation record

Status: **CURRENT — implemented and independently audited; PR CI/Copilot review pending**.
Date: 2026-10-05. Branch: `sqlite-milestone-2`, based on merged Milestone 1.

## Authority

Founder approved ADR-0016 with the Claude Code consultation's clarifications.
The accepted ADR and design updates are committed as `7cba17b`. An independent
agent checked that the documents matched that approval without expanding scope.

## Queue and native-definition checkpoint

- Node 24.15.0; SQLite 3.51.3; synthetic disposable on-disk databases only.
- Full local suite: 2,078 passed, 175 skipped; 53 tooling tests passed. This run
  preceded the final two author-link/regression-pin guards; the focused suite
  was rerun after those changes. Skipped database tests are not parity evidence.
- Latest focused SQLite storage/queue/definition suites: 38 passed.
- Typecheck, production build, and `git diff --check`: passed. Build reports
  the existing web bundle size advisory.
- No PostgreSQL migrations or shared evidence contracts changed. Dedicated
  PostgreSQL validation remains required before the completed milestone PR.

Independent agent `m2_design_audit` reviewed the implemented foundation in
successive passes. Resolved findings and retained regression coverage:

1. Recover expired queue leases even with all local slots occupied.
2. Use positive retry delay when callers request backoff without a delay.
3. Fence old polling generations across timed-out stop and restart.
4. Preserve criterion/definition author links except account erasure.
5. Reject unverifiable regression revision pins until their domain exists.

Final interim audit: no outstanding findings. The audit also verified account
erasure preserves author subjects and project erasure clears the definition and
authorization rows with clean foreign keys. This is not an audit of the remaining
Milestone 2 workflow, and is not approval to merge a partial milestone.

## Native import and collection checkpoint

- Full local Vitest suite after the slice: 2,084 passed, 175 skipped.
- Focused SQLite suites: 44 passed. Typecheck and production build passed.
- Repository boundary and shared-contract guards passed; `git diff --check`
  passed. The large-file report adds no new oversized files and still reports
  five pre-existing files needing classification.
- Independent `m2_design_audit` reviewed trace ingestion and the six collection
  methods. Its negative query-limit finding was fixed in trace and evaluator
  reads with regression tests. Final interim review has no remaining findings.
- No real provider calls, deployment, or PostgreSQL data changes occurred.

## Durable evaluation completion

The applied `0006_evaluation.sql` and worker-owned commands now persist native
runs/items, evaluator verdicts, immutable receipts, comparisons and corrections.
The shared evaluation worker runs through the SQLite queue. The staged HTTP
surface includes native authoring, collections, batches and receipt reads.

Validation on Node 24.15.0 / SQLite 3.51.3:

- Full application suite with two workers: **2,092 passed, 175 skipped**.
- Separate disposable UTF8/UTC PostgreSQL 17 regression run: **187 passed**.
  The cluster was stopped and removed afterward.
- Tooling tests: **53 passed**. Typecheck, production build, repository boundary
  guard, shared contract guard and whitespace checks passed.
- Six focused SQLite suites: **52 passed**, covering storage, queue,
  definitions, traces, evaluation and HTTP workflows. This final run includes
  malformed-artifact and unsupported-feature RPC/HTTP checks.
- No PostgreSQL migration, evidence wire contract, real provider call or
  deployed installation changed.

The first full test attempt used default concurrency and hit an existing
30-second structural-guard test timeout. It passed in the complete two-worker
rerun. An overlapping build caused one SQLite worker in the first PG run to
observe a partially rewritten shared module; the complete PG rerun after build
finished passed. These were validation orchestration problems, not ignored
failures or product fixes.

Independent reviewer `m2_execution_audit` audited the schema and command group,
then the final queue/HTTP/runtime integration, and independently ran **19 tests**.
Resolved findings:

1. Preserve mutable collection removal and ordinary raw-case retention while
   retaining receipts; verify project erasure clears the full graph.
2. Require a completion/cached verdict to belong to the exact evaluator version
   and case, with matching result/step projection.
3. Validate digest formats and explicitly reject NULL correction reasons.
4. Preserve the receipt integrity error class for malformed consumer/correction
   input, including canonicalization errors, across worker RPC.
5. Make item identity immutable so direct SQL cannot bypass collection tenant
   ownership while retaining an old dataset-item link.

Final independent audit approved the milestone for a PR after local checks,
with no remaining actionable findings. The exercised boundaries include live,
expired and replaced tokens; failure during receipt insertion rolling back the
item and counters; exact BLOB transport and restart; authenticated HTTP setup,
authoring, batch submission and cached replay; recovery after a committed run
but before queue send; and **SIGKILL during provider dispatch**, followed by one
uncertainty receipt without a second provider call.

Direct SQL fixtures reject terminal release commits without their reciprocal
receipt, modified terminal artifacts, forged canonical bytes/digests, NULL or
blank correction reasons, and skipped predecessors. Plain-connection integrity
and foreign-key checks succeed without application functions.

CI and a completed Copilot review remain required before merging the milestone.

## Copilot follow-up

CURRENT 2026-10-05: the first PR #194 CI run passed. Copilot requested
session-authenticated collection-run integration coverage. Added a synthetic
HTTP test that creates and populates a collection, submits `/api/eval-runs`,
changes a collection label before starting the durable worker, and verifies
terminal item identities, retained labels, agreement counters and two mock
provider calls. It asserts the collection mutation took effect. All three
SQLite HTTP workflow tests pass; independent review found no remaining issues
in this follow-up. The updated PR still requires fresh CI and Copilot review.
