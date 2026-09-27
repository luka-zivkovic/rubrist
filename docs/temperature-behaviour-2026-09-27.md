# Temperature behaviour, 2026-09-27

Status: **CURRENT evidence for ADR-0014 decision 12**, measured on
2026-09-27. Provider behaviour changes; re-measure before relying on a row.

## Question

Does a model let an evaluator's author choose its temperature, with a given
reasoning setting, or does it accept only its default? And where it accepts
a value, does the value take effect?

## Method

Each model and reasoning combination got a one-word prompt ("Reply with the
single word OK."), with a request in the provider's own API shape:

1. temperature omitted, to check the model answers at all;
2. temperature 0;
3. temperature 0.5, only where 0 was rejected;
4. temperature 1, only where 0.5 was rejected.

A result is classified from which requests were accepted, never from the
wording of a rejection. "Default" in the reasoning column means no
reasoning fields were sent (for Claude Opus 4.8, no thinking); Sonnet 4.6's
"thinking enabled" used a 1,024-token budget. Fireworks model ids are shown
without their `accounts/fireworks/models/` prefix.

The spread test asked six times for "a name for a brand-new colour" at a low
and a high temperature and counted distinct answers, after lowercasing them
and removing everything but letters and spaces. A temperature that
takes effect gives more variety at the high temperature; one that is ignored
gives about the same variety at both. Six answers is a small sample, so a
spread result supports a table entry but doesn't prove one.

Anthropic calls went to the Messages API, OpenAI calls to Chat Completions,
and Fireworks calls to its OpenAI-compatible endpoint
(`https://api.fireworks.ai/inference/v1`), the API shape Rubrist's `custom`
provider uses; the study sent no verdict tool or response format. No Rubrist
code was involved; requests carried no project data.

## Results

| Host | Model | Reasoning | Temperature 0 | 0.5 | 1 | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Anthropic | `claude-haiku-4-5-20251001` | no thinking | accepted | — | — | lets the author choose |
| Anthropic | `claude-sonnet-4-6` | no thinking | accepted | — | — | lets the author choose |
| Anthropic | `claude-sonnet-4-6` | thinking enabled | 400 | 400 | accepted | only its default (1) |
| Anthropic | `claude-opus-4-8` | default | 400 | 400 | accepted | only its default (1) |
| Anthropic | `claude-opus-5-5` | adaptive (default) | 400 | 400 | accepted | only its default (1) |
| Anthropic | `claude-sonnet-5` | adaptive (default) | 400 | 400 | accepted | only its default (1) |
| Anthropic | `claude-sonnet-5` | thinking disabled | 400 | 400 | accepted | only its default (1) |
| Anthropic | `claude-fable-5-1` | default | 400 | 400 | accepted | only its default (1) |
| OpenAI | `gpt-4.1` | no reasoning | accepted | — | — | lets the author choose |
| OpenAI | `gpt-5.4` | reasoning default | accepted | — | — | lets the author choose |
| OpenAI | `gpt-5.4` | reasoning_effort none | accepted | — | — | lets the author choose |
| OpenAI | `gpt-5.5` | reasoning default | 400 | 400 | accepted | only its default (1) |
| OpenAI | `gpt-5.5` | reasoning_effort none | accepted | — | — | lets the author choose |
| OpenAI | `gpt-5.6-sol` | reasoning default | 400 | 400 | accepted | only its default (1) |
| OpenAI | `gpt-5.6-sol` | reasoning_effort none | accepted | — | — | lets the author choose |
| OpenAI | `gpt-6-sol` | reasoning default | 400 | 400 | accepted | only its default (1) |
| OpenAI | `gpt-6-sol` | reasoning_effort none | accepted | — | — | lets the author choose |
| OpenAI | `o3` | reasoning default | 400 | 400 | accepted | only its default (1) |
| Fireworks | `kimi-k3` | default | accepted | — | — | lets the author choose |
| Fireworks | `deepseek-v4-pro` | default | — | — | — | not deployed (404) |
| Fireworks | `qwen3p8-max` | default | accepted | — | — | lets the author choose |
| Fireworks | `glm-5p3` | default | accepted | — | — | lets the author choose |
| Fireworks | `gpt-oss-120b` | default | accepted | — | — | lets the author choose |
| Fireworks | `minimax-m3` | default | accepted | — | — | lets the author choose |
| Fireworks | `deepseek-v4p1-flash` | default | accepted | — | — | lets the author choose |
| Fireworks | `deepseek-v4-pro-0813` | default | — | — | — | not deployed (404) |
| Fireworks | `deepseek-v4-flash-0731` | default | — | — | — | not deployed (404) |

Three DeepSeek builds listed by Fireworks returned 404 ("Model not found,
inaccessible, and/or not deployed"): they aren't served on its pay-per-use
tier.

### Spread test

| Host | Model | Reasoning | Distinct answers at the low temperature | Distinct answers at the high temperature |
| --- | --- | --- | --- | --- |
| OpenAI | `gpt-4.1` | no reasoning | 1 of 6 (T=0) | 6 of 6 (T=1.5) |
| Anthropic | `claude-haiku-4-5-20251001` | no thinking | 1 of 6 (T=0) | 4 of 6 (T=1) |
| Fireworks | `kimi-k3` | default | 4 of 6 (T=0) | 6 of 6 (T=1.5) |
| Fireworks | `gpt-oss-120b` | default | 1 of 6 (T=0) | 6 of 6 (T=1.5) |
| OpenAI | `gpt-5.4` | reasoning_effort none | 1 of 6 (T=0) | 6 of 6 (T=1.5) |
| Fireworks | `deepseek-v4p1-flash` | default | 5 of 6 (T=0) | 6 of 6 (T=1.5) |

DeepSeek v4.1 flash accepted temperature 0 but gave nearly as many distinct
answers at 0 as at 1.5. That is consistent with DeepSeek's documentation
that its thinking mode ignores temperature, but it doesn't prove it: the
documentation covers DeepSeek's own API, not Fireworks, the study sent no
reasoning fields and didn't confirm thinking was on, and six answers are
few.

Kimi K3 gave about as few repeats at 0 (4 of 6). It is judged to respond to
temperature because four of its six answers at 1.5 degenerated into long,
rambling text, which DeepSeek's didn't. The distinct-answer count alone
doesn't separate the two, which is why a spread test alone can't list a
model as ignoring temperature (ADR-0014 decision 12).

### Rejection messages

The same fact, that only the default of 1 is accepted, came back in several
wordings:

- Anthropic, 2 times: "`temperature` may only be set to 1 when thinking is
  enabled."
- Anthropic, 10 times: "`temperature` is deprecated for this model."
- OpenAI, 4 times: "Unsupported value: 'temperature' does not support 0
  with this model. Only the default (1) value is supported."
- OpenAI, 4 times: the same for 0.5.

Earlier the same day, outside this study and not counted in its calls, the
Batch 8 exit-gate checks and a two-call probe sent thinking explicitly as
adaptive. There Opus 5.5 and Sonnet 5 answered "`temperature` may only be
set to 1 when thinking is enabled or in adaptive mode", while Sonnet 5 with
thinking disabled answered "`temperature` is deprecated for this model". The
wording depends on the request, not only the model.

## Findings

- **Only the default.** Claude Opus 4.8, Opus 5.5, Sonnet 5 (adaptive and
  thinking disabled), Fable 5.1, Sonnet 4.6 with thinking enabled, and
  OpenAI's gpt-5.5, gpt-5.6-sol, gpt-6-sol, and o3 at their default
  reasoning reject 0 and 0.5 and accept 1.
- **Reasoning changes the answer.** gpt-5.5, gpt-5.6-sol, and gpt-6-sol
  accept temperature 0 at reasoning effort `none`. gpt-5.4 accepts it at its
  default reasoning too. Sonnet 4.6 accepts it only with thinking off.
- **Messages vary; outcomes don't.** Classifying by accepted or rejected
  sorted every usable combination. A classifier reading the words would have
  mistaken "deprecated" for "the parameter is not supported" although 1 is
  accepted.
- **Accepted may not be applied.** A model can accept a temperature and, by
  its provider's documentation, ignore it, so an ignored temperature needs a
  separate, dated record backed by that documentation.
- **Temperature 0 is not a determinism guarantee** (Kimi K3).

## Cost

143 calls: 40 to Anthropic, 52 to OpenAI, and 51 to Fireworks, most of
them a few hundred tokens.
