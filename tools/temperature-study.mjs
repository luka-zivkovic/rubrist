#!/usr/bin/env node
// Temperature study: reproduces the probes behind ADR-0014 decision 12
// (docs/temperature-behaviour-2026-09-27.md) for a list of targets, to review
// the ignored-temperature table (packages/shared/src/ignored-temperature.ts).
// A maintenance script, never run in CI: every target costs live provider calls.
//
// Usage:
//   ANTHROPIC_API_KEY=… OPENAI_API_KEY=… FIREWORKS_API_KEY=… DEEPSEEK_API_KEY=… \
//     node tools/temperature-study.mjs [--targets targets.json] [--spread]
//
// Each target is sent a one-word prompt without temperature, then temperature
// 0, 0.5 only where 0 was rejected, and 1 only where 0.5 was rejected. It is
// classified from which requests were accepted, never from a rejection's
// wording. With --spread, a target that accepted 0 is also asked six times for
// a new colour's name at a low and a high temperature, and the distinct
// answers are counted; a spread result can support a table entry, but never
// lists one alone.
//
// A targets file is a JSON array of
//   { "label": "Fireworks", "api": "anthropic" | "openai-chat", "baseUrl": "https://…",
//     "keyEnv": "FIREWORKS_API_KEY", "model": "…", "reasoning": { …request fields } | null,
//     "tokenParam": "max_tokens" | "max_completion_tokens" }
// where "reasoning" is added to every request as the provider spells it (for
// example { "reasoning_effort": "none" }). Without a file, the study's own
// targets are used. Keys come only from the environment variable each target
// names and are never printed; a target whose key is unset is skipped.
//
// Exit codes: 0 when the study ran, 2 on a usage or configuration error.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PROMPT = "Reply with the single word OK.";
const SPREAD_PROMPT = "Invent a name for a brand-new colour. Reply with the name only.";
const SPREAD_SAMPLES = 6;
const TIMEOUT_MS = 60_000;
// Thinking enabled with a 1,024-token budget needs room above it.
const MAX_TOKENS = 2_048;

const anthropic = (model, reasoning = null) => ({
  label: "Anthropic", api: "anthropic", baseUrl: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY", model, reasoning, tokenParam: "max_tokens"
});
const openai = (model, reasoning = null) => ({
  label: "OpenAI", api: "openai-chat", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", model, reasoning, tokenParam: "max_completion_tokens"
});
const fireworks = (model) => ({
  label: "Fireworks", api: "openai-chat", baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY",
  model: `accounts/fireworks/models/${model}`, reasoning: null, tokenParam: "max_tokens"
});
const deepseek = (model, reasoning = null) => ({
  label: "DeepSeek", api: "openai-chat", baseUrl: "https://api.deepseek.com", keyEnv: "DEEPSEEK_API_KEY", model, reasoning, tokenParam: "max_tokens"
});
const NO_REASONING = { reasoning_effort: "none" };

/** The study's targets (docs/temperature-behaviour-2026-09-27.md), and DeepSeek's own API, which the table lists. */
export const STUDY_TARGETS = [
  anthropic("claude-haiku-4-5-20251001"),
  anthropic("claude-sonnet-4-6"),
  anthropic("claude-sonnet-4-6", { thinking: { type: "enabled", budget_tokens: 1_024 } }),
  anthropic("claude-opus-4-8"),
  anthropic("claude-opus-5-5"),
  anthropic("claude-sonnet-5"),
  anthropic("claude-sonnet-5", { thinking: { type: "disabled" } }),
  anthropic("claude-fable-5-1"),
  openai("gpt-4.1"),
  openai("gpt-5.4"),
  openai("gpt-5.4", NO_REASONING),
  openai("gpt-5.5"),
  openai("gpt-5.5", NO_REASONING),
  openai("gpt-5.6-sol"),
  openai("gpt-5.6-sol", NO_REASONING),
  openai("gpt-6-sol"),
  openai("gpt-6-sol", NO_REASONING),
  openai("o3"),
  ...["kimi-k3", "qwen3p8-max", "glm-5p3", "gpt-oss-120b", "minimax-m3", "deepseek-v4p1-flash"].map(fireworks),
  deepseek("deepseek-flash"),
  deepseek("deepseek-flash", { reasoning_effort: "high" })
];

/** A provider message as the study prints it: the key removed, bounded. */
export function redact(message, key) {
  const text = String(message ?? "");
  return (key ? text.split(key).join("[redacted]") : text).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** One request, in the target's API shape; `temperature` null means not sent. */
export function buildRequest(target, key, { temperature, prompt }) {
  const anthropicApi = target.api === "anthropic";
  return {
    url: `${target.baseUrl}/${anthropicApi ? "messages" : "chat/completions"}`,
    headers: anthropicApi
      ? { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }
      : { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: {
      model: target.model,
      messages: [{ role: "user", content: prompt }],
      [target.tokenParam ?? "max_tokens"]: MAX_TOKENS,
      ...(target.reasoning ?? {}),
      ...(temperature === null ? {} : { temperature })
    }
  };
}

/**
 * Sends one request and reads its outcome: accepted on 2xx, rejected on a 4xx
 * other than authentication, timeout, or rate limit, and an error otherwise.
 */
export async function send(target, key, options, fetchImpl = fetch) {
  const request = buildRequest(target, key, options);
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    return { outcome: "error", status: null, message: redact(error instanceof Error ? error.message : error, key), text: null };
  }
  const raw = await response.text().catch(() => "");
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (response.ok) {
    const text = target.api === "anthropic"
      ? (body?.content ?? []).filter((block) => block?.type === "text").map((block) => block.text).join("")
      : body?.choices?.[0]?.message?.content ?? null;
    return { outcome: "accepted", status: response.status, message: null, text };
  }
  const rejected = response.status >= 400 && response.status < 500 && ![401, 403, 408, 429].includes(response.status);
  return { outcome: rejected ? "rejected" : "error", status: response.status, message: redact(body?.error?.message ?? raw, key), text: null };
}

/**
 * The study's result for one target, from which requests were accepted
 * (ADR-0014 decision 12), and what Rubrist's check would record: `adjustable`
 * where 0 or 0.5 was accepted, `not_adjustable` where both were rejected.
 */
export function classifyTemperature(outcomes) {
  if (outcomes.none !== "accepted") return { result: outcomes.none === "rejected" ? "not served" : "no answer", rubrist: "unknown" };
  if (outcomes[0] === "accepted") return { result: "lets the author choose", rubrist: "adjustable" };
  if (outcomes[0] !== "rejected") return { result: "unknown", rubrist: "unknown" };
  if (outcomes[0.5] === "accepted") return { result: "lets the author choose (0 rejected)", rubrist: "adjustable" };
  if (outcomes[0.5] !== "rejected") return { result: "unknown", rubrist: "unknown" };
  if (outcomes[1] === "accepted") return { result: "only its default (1)", rubrist: "not_adjustable" };
  return { result: outcomes[1] === "rejected" ? "rejects 0, 0.5, and 1" : "not adjustable (1 unknown)", rubrist: "not_adjustable" };
}

/** Distinct answers after lowercasing and keeping only letters and spaces, as the study counted them. */
export function distinctAnswers(texts) {
  return new Set(texts.map((text) => String(text ?? "").toLowerCase().replace(/[^\p{L} ]/gu, "").replace(/\s+/g, " ").trim())).size;
}

/** Probes one target, and with `spread` samples it at a low and a high temperature where it accepted 0. */
export async function studyTarget(target, { key, spread = false, fetchImpl = fetch }) {
  const outcomes = {};
  const messages = [];
  let calls = 0;
  const ask = async (temperature, prompt = PROMPT) => {
    calls += 1;
    const answer = await send(target, key, { temperature, prompt }, fetchImpl);
    if (answer.message) messages.push(answer.message);
    return answer;
  };
  outcomes.none = (await ask(null)).outcome;
  // Each temperature only where the one before it was rejected.
  for (const temperature of [0, 0.5, 1]) {
    if (outcomes.none !== "accepted" || (temperature !== 0 && outcomes[temperature === 0.5 ? 0 : 0.5] !== "rejected")) break;
    outcomes[temperature] = (await ask(temperature)).outcome;
  }
  let spreadResult = null;
  if (spread && outcomes[0] === "accepted") {
    // Anthropic takes temperatures up to 1; the OpenAI shape up to 2.
    const high = target.api === "anthropic" ? 1 : 1.5;
    const sample = async (temperature) => {
      const texts = [];
      for (let index = 0; index < SPREAD_SAMPLES; index += 1) texts.push((await ask(temperature, SPREAD_PROMPT)).text);
      return distinctAnswers(texts);
    };
    spreadResult = { low: await sample(0), high: await sample(high), highTemperature: high };
  }
  return { target, outcomes, ...classifyTemperature(outcomes), spread: spreadResult, messages, calls };
}

const describeReasoning = (reasoning) => reasoning === null || reasoning === undefined ? "default" : JSON.stringify(reasoning);
const cell = (outcome) => outcome === undefined ? "—" : outcome;

/** The study's table, in Markdown. */
export function formatTable(rows) {
  const lines = [
    "| Host | Model | Reasoning | Temperature 0 | 0.5 | 1 | Result | Rubrist |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.target.label} | \`${row.target.model}\` | ${describeReasoning(row.target.reasoning)} | ${cell(row.outcomes[0])} | ${cell(row.outcomes[0.5])} | ${cell(row.outcomes[1])} | ${row.result} | ${row.rubrist} |`)
  ];
  const spread = rows.filter((row) => row.spread !== null);
  if (spread.length > 0) {
    lines.push("", `| Host | Model | Reasoning | Distinct of ${SPREAD_SAMPLES} at T=0 | Distinct at the high temperature |`, "| --- | --- | --- | --- | --- |");
    for (const row of spread) {
      lines.push(`| ${row.target.label} | \`${row.target.model}\` | ${describeReasoning(row.target.reasoning)} | ${row.spread.low} | ${row.spread.high} (T=${row.spread.highTemperature}) |`);
    }
  }
  return lines.join("\n");
}

function fail(message) {
  console.error(`temperature-study: ${message}`);
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("node tools/temperature-study.mjs [--targets targets.json] [--spread]");
    return;
  }
  const unknown = args.filter((arg, index) => arg !== "--spread" && arg !== "--targets" && args[index - 1] !== "--targets");
  if (unknown.length > 0) fail(`unknown argument(s): ${unknown.join(", ")}`);
  const file = args.includes("--targets") ? args[args.indexOf("--targets") + 1] : null;
  let targets = STUDY_TARGETS;
  if (file !== null) {
    try {
      targets = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      fail(`can't read ${file}: ${error instanceof Error ? error.message : error}`);
    }
    if (!Array.isArray(targets) || targets.some((target) => typeof target?.model !== "string" || typeof target?.keyEnv !== "string" ||
        typeof target?.baseUrl !== "string" || !["anthropic", "openai-chat"].includes(target?.api))) {
      fail("a targets file is a JSON array of { label, api, baseUrl, keyEnv, model, reasoning, tokenParam }");
    }
  }
  const rows = [];
  const skipped = new Set();
  let calls = 0;
  for (const target of targets) {
    const key = process.env[target.keyEnv]?.trim();
    if (!key) {
      skipped.add(target.keyEnv);
      continue;
    }
    const row = await studyTarget(target, { key, spread: args.includes("--spread") });
    calls += row.calls;
    rows.push(row);
  }
  console.log(formatTable(rows));
  const messages = [...new Set(rows.flatMap((row) => row.messages))];
  if (messages.length > 0) console.log(`\nRejection and error messages:\n${messages.map((message) => `- ${message}`).join("\n")}`);
  console.log(`\n${calls} calls on ${new Date().toISOString().slice(0, 10)}.${skipped.size > 0 ? ` Skipped targets whose key is unset: ${[...skipped].join(", ")}.` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
