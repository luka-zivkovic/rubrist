# Evaluator authorship declarations

TARGET / authorized checklist: keep the account that saves an evaluator separate
from who drafted it. Authorship does not grant approval, validation, governed
human truth, or execution permission.

## Contract and state table

CURRENT after this change: create-version, onboarding, and governed-candidate
inputs accept optional `rubricProvenance`. This describes the whole new
version, including its rubric or typed question, prompt and configuration.

| Input/source | Stored provenance | Declaration recorded |
| --- | --- | --- |
| Explicit human declaration | human-authored | true |
| Explicit agent declaration (including agent-assisted work) | agent-drafted | true |
| Missing or unspecified | unspecified | false |
| Dedicated agent setup | agent-drafted | true |
| System starter | unspecified | false |
| Existing version | unchanged | false |

The existing account/subject audit identity is unchanged. A declaration is
self-reported, not proof of authorship. The editor offers an optional declaration,
starts unspecified for each edit, and never copies authorship from its base.
Historical recorded labels remain visible with an explanation that older saves
could infer human authorship from the account; they are not relabeled.

## Storage and compatibility

Migration 0003 preserves 0001 and 0002 and every existing column value. It adds
`rubric_provenance_declared` (default false), allows `unspecified`, changes the
new-row provenance default to unspecified, and makes both fields immutable.
No backfill guesses authorship. Existing clients may omit the declaration;
current response readers accept the third enum value. Old app images that only
accept two values cannot read new unspecified versions: deploy readers and
writers together, and prefer a forward fix over rolling back application images.
Frozen assessment/SkillFormat/lifecycle artifact contracts and evaluator identity
remain unchanged. Optional input stays absent when omitted so existing onboarding
and governed-candidate idempotency request digests remain stable on retries.

## Verification

Cover owner-session agent declarations, explicit human and absent declarations,
queued/inline/demo/onboarding paths, dedicated agent precedence, governed
candidate input, editor defaults and submission, exported history, immutable
storage, clean install/repeat migration, and upgrade preservation. Hosted rollout
requires a fresh restorable backup and preservation checks including the ten
completed follow-up reviews.
