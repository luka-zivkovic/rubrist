# AI contributor context

Before planning, auditing, or changing Rubrist, read:

1. `PRODUCT.md` — authoritative target product scope;
2. `docs/glossary.md` — shared terminology;
3. `docs/decisions/README.md` and the relevant ADRs;
4. `docs/implementation-batches.md` — independently audited work sequencing;
   Batch 0 is authorized, while each later batch waits for its named decision
   gates;
5. `README.md` and `docs/architecture.md` — current implementation guidance;
6. code and tests — current behavior.

For competitor or market claims, also read `docs/positioning.md` and refresh
its dated sources. It is context, never product authority.

## Authority and evidence labels

- Accepted ADRs and `PRODUCT.md` define intended direction.
- Proposed ADRs are unresolved. Do not implement behavior that depends on one
  without explicit approval.
- README, plans, UI copy, comments, and code can describe **CURRENT** behavior
  but cannot establish **TARGET** product intent when they conflict with the
  charter.
- In audits and plans, label material claims as `TARGET`, `CURRENT`, or
  `ASSUMPTION`.
- Do not infer roadmap scope from historical files. `docs/ecosystem-plan.md`
  and `docs/evidence-tier-gating.md` are explicitly non-authoritative.

## Product boundary

Rubrist owns the analyze-to-measure evaluator lifecycle: failure taxonomy,
governed human truth, single-criterion evaluators, policy-free suites,
calibration, pinned execution, and immutable assessment evidence. It also owns
production outcome monitoring, which is ungoverned development feedback kept
separate from that evidence. It does not own release thresholds,
`promote`/`block` decisions, rollouts, or deployment overrides.
Dailies owns release decisions. Casefile owns deterministic no-execution trust
intake for capability artifacts.

Semantic clustering is deferred. Do not add it to plans or implementations.

## Working tree

The repository may contain uncommitted work from coordinated batches. Preserve
unrelated changes, inspect diffs before editing, and never treat an uncommitted
document as accepted merely because it exists.

## SQLite milestone pull requests

After each authorized SQLite deployment milestone passes its checks and
independent audit, commit it, push its milestone branch to `origin`, and open
one PR without asking again. Update an existing milestone PR rather than
creating a duplicate. Target `main` when its prerequisites have merged;
otherwise target the previous milestone branch and state the dependency.

Inspect CI and Copilot review results on the PR. Address actionable findings
and push fixes to that same PR. Copilot supplements the independent audit and
tests; its review is not authority to change product scope or accept an ADR.
Report the PR URL and any pending checks. PR creation/review authorization
does not authorize merging or deploying. See `docs/pull-request-reviews.md`.
