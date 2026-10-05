# Milestone PRs and Copilot review

CURRENT workflow, authorized 2026-10-05. Each completed SQLite milestone is
pushed and opened as one PR after local validation and independent audit.
Follow-up corrections update that PR. Merging and deployment are separate
actions that need their own authorization.

## Stacked milestones

Use `sqlite-milestone-N` branches. A milestone targets `main` if its predecessor
has merged; otherwise it targets the predecessor branch and its PR description
names that dependency. This keeps the review diff limited to one milestone.
After an authorized predecessor merge, inspect the descendant diff and retarget
it to `main` (or the next unmerged predecessor); preserve changes when handling
squash merges. Check CI again after retargeting. Keep predecessor branches while
open descendants depend on them.

The CI pull-request filter includes `main` and `sqlite-milestone-*`, because
GitHub applies that filter to the PR's base branch. Existing push behavior and
read-only workflow permissions remain unchanged. No privileged review workflow
or additional token secret is needed.

## Native Copilot rules

The repository uses GitHub's native `copilot_code_review` ruleset rule:

| Target | Review on new pushes | Review drafts | Other rules |
| --- | --- | --- | --- |
| Default branch | Enabled | Enabled | Existing deletion and force-push protections retained |
| `refs/heads/sqlite-milestone-*` | Enabled | Enabled | Copilot review only |

The milestone ruleset is separate so default-branch protections do not prevent
ordinary cleanup of merged milestone branches. These are GitHub settings, not
settings that take effect merely by committing this document. Verify the live
state with `gh api repos/luka-zivkovic/rubrist/rulesets` and inspect each rule.

Repository review guidance lives in `.github/copilot-instructions.md`. It
prioritizes auth isolation, transaction/crash safety, immutable evidence and
product boundaries. Keep it short and consistent with AGENTS and accepted ADRs.

Copilot must be available to the PR author and have remaining review capacity.
A requested or pending review is not a completed review. Inspect the Reviews
section and CI checks, assess each finding, fix actionable defects, and request
a new review if an automatic review did not trigger. Record any unavailable
review explicitly rather than treating it as approval. Copilot does not replace
the independent audit required by the regular batch flow.

References: [GitHub automatic review configuration](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review),
[custom review instructions](https://docs.github.com/en/copilot/tutorials/customize-code-review).

## Configuration verification

CURRENT verified 2026-10-05: native rulesets
[24357304](https://github.com/luka-zivkovic/rubrist/rules/24357304) and
[24511595](https://github.com/luka-zivkovic/rubrist/rules/24511595) were read back
after configuration with both review flags enabled. Independent review found
no blocking issues in the workflow, instructions or ruleset payloads. The CI
YAML parsed successfully; assertions confirmed the two PR base filters,
main-only pushes and unchanged read-only permissions. This validates the
configuration; each PR still needs its own completed checks and review.
