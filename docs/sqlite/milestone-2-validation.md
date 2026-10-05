# Milestone 2 validation record

Status: **CURRENT — interim foundation only, not milestone completion**.
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

## Outstanding milestone validation

Imports, datasets, evaluation runs/items, provider dispatch ownership, exact-byte
receipt mint/retrieval, authenticated end-to-end restart/failure injection,
PostgreSQL regression checks, full milestone independent audit, CI, and Copilot
review remain outstanding. No Milestone 2 PR has been opened yet.
