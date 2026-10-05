# Rubrist review instructions

Read `AGENTS.md`, `PRODUCT.md`, `docs/glossary.md`, the ADR index and relevant
accepted ADRs before judging product intent. Accepted ADRs and PRODUCT are
authoritative; proposed ADRs are unresolved. README, plans and existing code
can describe CURRENT behavior but cannot override TARGET scope.

## Review priorities

- Report concrete correctness, security, data-loss and regression risks caused
  by the diff. Give the triggering scenario, affected behavior, severity and
  the smallest relevant file/line range. Distinguish confirmed defects from
  questions; avoid speculative requirements and cosmetic churn.
- Check tenant membership, owner permissions, token capability, one-time use,
  expiry and races. Persistent storage failure must never enable demo or
  disable authentication. Credentials must stay encrypted/redacted; tokens
  must retain the project's existing hash and revocation guarantees.
- Preserve transaction ownership and atomic evidence writes. Check direct
  database constraints, concurrent requests, idempotency, restart recovery,
  stale-worker rejection and uncertainty after provider dispatch. Do not
  treat queue delivery as proof of exactly-once model execution.
- Preserve exact canonical bytes, digests, pinned identities, immutable
  artifacts, append-only correction/history and sealed-data exposure rules.
  Keep production monitoring separate from governed truth and evidence.
- Preserve existing PostgreSQL migration checksums and hosted review data
  under ADR-0011's exception. Backend-specific migrations need ordered,
  checksummed, retryable histories and incompatible-history rejection.
- Rubrist does not own release thresholds, promote/block decisions, rollouts
  or overrides. Semantic clustering is deferred.

## SQLite milestone scope

Read `docs/sqlite-deployment-plan.md` and the changed milestone's validation
record. Judge the declared milestone, not unfinished later milestones. Flag
false parity/completion claims or silent weakening of guarantees. Explicit
unavailable responses for unported workflows are intentional at intermediate
checkpoints. Proposed ADR-0016 is not permission to change evidence contracts.
Use synthetic data; the LangTracer pilot is paused.

## Validation

Check that tests cover the changed behavior and meaningful failure/race paths.
For shared auth/storage changes, require relevant SQLite and PostgreSQL
coverage; skipped PG tests do not prove PG compatibility. Follow the repository
batch checks (typecheck, tests, applicable database tests, build, contracts and
repository-boundary guards). Do not claim a command ran based on an assertion
in the PR description. Copilot findings supplement tests and independent review
and do not authorize merging, deployment or acceptance of proposed decisions.
