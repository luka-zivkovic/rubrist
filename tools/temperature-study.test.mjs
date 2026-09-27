import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STUDY_TARGETS,
  buildRequest,
  classifyTemperature,
  distinctAnswers,
  formatTable,
  redact,
  studyTarget
} from "./temperature-study.mjs";

// The temperature study's own logic, over a stubbed transport: it never calls a provider here.

const KEY = "sk-study-secret";
const OPUS = STUDY_TARGETS.find((target) => target.model === "claude-opus-5-5");
const GPT = STUDY_TARGETS.find((target) => target.model === "gpt-4.1");

/** A provider that accepts a request when `accepts` says so, and otherwise rejects it with 400. */
function provider(accepts, text = () => "OK") {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push({ url, headers: init.headers, body });
    if (!accepts(body)) {
      return new Response(JSON.stringify({ error: { message: `temperature is deprecated for this model (key ${KEY})` } }), { status: 400 });
    }
    return new Response(JSON.stringify(url.endsWith("/messages")
      ? { content: [{ type: "text", text: text(body) }] }
      : { choices: [{ message: { content: text(body) } }] }));
  };
  return { bodies, fetchImpl };
}

test("classifies by which requests were accepted, never by the wording", () => {
  assert.deepEqual(classifyTemperature({ none: "accepted", 0: "accepted" }), { result: "lets the author choose", rubrist: "adjustable" });
  assert.deepEqual(classifyTemperature({ none: "accepted", 0: "rejected", 0.5: "accepted" }), { result: "lets the author choose (0 rejected)", rubrist: "adjustable" });
  assert.deepEqual(classifyTemperature({ none: "accepted", 0: "rejected", 0.5: "rejected", 1: "accepted" }), { result: "only its default (1)", rubrist: "not_adjustable" });
  assert.deepEqual(classifyTemperature({ none: "accepted", 0: "rejected", 0.5: "rejected", 1: "rejected" }).rubrist, "not_adjustable");
  assert.deepEqual(classifyTemperature({ none: "accepted", 0: "error" }).rubrist, "unknown");
  assert.deepEqual(classifyTemperature({ none: "rejected" }), { result: "not served", rubrist: "unknown" });
});

test("sends 0, then 0.5 and 1 only after a rejection, in the provider's own shape", async () => {
  const onlyDefault = provider((body) => body.temperature === undefined || body.temperature === 1);
  const row = await studyTarget(OPUS, { key: KEY, fetchImpl: onlyDefault.fetchImpl });
  assert.deepEqual(onlyDefault.bodies.map(({ body }) => body.temperature), [undefined, 0, 0.5, 1]);
  assert.equal(onlyDefault.bodies[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(onlyDefault.bodies[0].headers["x-api-key"], KEY);
  assert.deepEqual({ result: row.result, rubrist: row.rubrist, calls: row.calls }, { result: "only its default (1)", rubrist: "not_adjustable", calls: 4 });

  const choosing = provider(() => true);
  assert.equal((await studyTarget(GPT, { key: KEY, fetchImpl: choosing.fetchImpl })).rubrist, "adjustable");
  assert.equal(choosing.bodies.length, 2);
  assert.equal(choosing.bodies[0].headers.authorization, `Bearer ${KEY}`);
  assert.ok("max_completion_tokens" in choosing.bodies[0].body);
});

test("never prints a key", async () => {
  const onlyDefault = provider((body) => body.temperature === undefined);
  const row = await studyTarget(OPUS, { key: KEY, fetchImpl: onlyDefault.fetchImpl });
  assert.ok(row.messages.length > 0);
  assert.ok(row.messages.every((message) => !message.includes(KEY) && message.includes("[redacted]")));
  assert.ok(!formatTable([row]).includes(KEY));
  assert.equal(redact(`bad key ${KEY}`, KEY), "bad key [redacted]");
});

test("samples the spread at a low and a high temperature, counting normalized answers", async () => {
  let call = 0;
  const colours = provider(() => true, (body) => body.temperature === 0 ? "Dusk Teal!" : `Colour ${"abcdef"[call++ % 6]}`);
  const row = await studyTarget(GPT, { key: KEY, spread: true, fetchImpl: colours.fetchImpl });
  assert.deepEqual(row.spread, { low: 1, high: 6, highTemperature: 1.5 });
  assert.equal(distinctAnswers(["Dusk Teal", "dusk  teal.", "DUSK TEAL"]), 1);
  assert.match(formatTable([row]), /\| OpenAI \| `gpt-4\.1` \| default \| 1 \| 6 \(T=1\.5\) \|/);
});

test("adds a target's reasoning fields to every request, as the provider spells them", () => {
  const none = STUDY_TARGETS.find((target) => target.model === "gpt-5.5" && target.reasoning !== null);
  const request = buildRequest(none, KEY, { temperature: 0, prompt: "p" });
  assert.equal(request.body.reasoning_effort, "none");
  assert.equal(request.body.temperature, 0);
  assert.equal(buildRequest(none, KEY, { temperature: null, prompt: "p" }).body.temperature, undefined);
});
