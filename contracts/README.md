# Rubrist evidence contracts

## Binary calibration artifact v1

`binary-calibration-v1.schema.json` is the contract Rubrist emits for sealed
calibration (Rubrist ADR-0014 section 7). The evaluator is the evaluator
identity, with `skillDigest` and `requestedBindingDigest` recomputed from it;
error codes are the shared failure taxonomy; never-attempted items are
`notAttempted`; private-ledger records carry the shared item result; and
provider groups record the OpenRouter upstream. Three exact-canonical
positive fixtures cover a prompted, a typed-question, and an OpenRouter
evaluator, and an adversarial corpus covers the semantic rules. The normative
rules are in [`binary-calibration-v1.md`](binary-calibration-v1.md).

## Evaluator suite manifest v1

`evaluator-suite-manifest-v1.schema.json` is the suite manifest Rubrist
publishes: an immutable ordered suite that binds each criterion definition to
one exact evaluator version and output contract, with no release roles,
weights, thresholds, aggregation, or release decision. Members carry the
`skillDigest` that the assessment receipt and the calibration artifact
recompute from their evaluator identity, and the output-contract digest. The
positive fixture names a prompted and a typed-question evaluator, and the
corpus covers the raw-input guards the assessment receipt uses. The normative
rules are in [`evaluator-suite-manifest-v1.md`](evaluator-suite-manifest-v1.md).

## Skill format v1

`skill-format-v1.schema.json` is the portable export of one evaluator version.
It carries the full definition, the execution binding, and a typed question's
text, with the digests an importer recomputes and compares with the identity
it expected. The normative rules are in [`skill-format-v1.md`](skill-format-v1.md).

## Assessment receipt v1

`assessment-receipt-v1.schema.json` is the closed, policy-free wire contract
Rubrist emits for every terminal `release_evidence` run (Rubrist ADR-0014
sections 6 and 7, decision 5). It carries the execution binding and a digest
of the evaluator definition, never rubric, prompt, or question text, and
`skillDigest` is recomputed from them. Each item has exactly one outcome,
failure, or `not_attempted` result, a score whose kind the verdict protocol
fixes, and observed provider provenance. An abstention leaves a receipt
complete.

Two positive vectors cover a complete prompted receipt with an abstention and
an incomplete typed-question receipt, and the conformance corpus covers
schema/runtime parity, every digest, the binding's rules, and each semantic
rule. The normative rules and pinned file digests are in
[`assessment-receipt-v1.md`](assessment-receipt-v1.md).

## Version policy

- Rubrist owns the canonical contract; consumers vendor a reviewed copy and
  independently verify it. See
  [ADR-0001](../docs/decisions/0001-evidence-contract-ownership-and-versioning.md).
- Every contract starts at v1 at launch (ADR-0014 decision 7); no earlier
  version is kept.
- Every contract's parsers are intentionally strict at every object
  boundary, so adding, removing, or renaming a field is a breaking change.
- After launch, a breaking change requires a new schema version, new
  fixtures, and a coordinated consumer release, and no optional field is
  added to a published version.
- Rubrist emits governed assessment evidence only. Thresholds and release
  decisions are forbidden from the receipt.
- Calibration does not extend the receipt. ADR-0009 accepts a separate
  aggregate-only calibration artifact, now `rubrist/binary-calibration/v1`,
  which Rubrist mints from its sealed execution runtime.
- The JSON Schema documents the structural contract. Runtime verifiers must
  additionally recompute the canonical evidence and dataset digests and check
  semantic invariants such as complete counters and exact item coverage.

The contract is vendored by consumers instead of published as a shared runtime
package. This keeps release cadences independent while byte-pinned positive and
negative vectors make schema and semantic drift visible in both test suites.
