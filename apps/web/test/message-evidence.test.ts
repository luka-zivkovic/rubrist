import { describe, expect, it } from "vitest";
import { isRecordedTrajectory, messageEvidence, messageGroups, sourceMessageIndices, WHOLE_TRAJECTORY_SCOPE } from "../src/lib/message-evidence.js";
const metadata = { evidenceProjection: "whole-trajectory-v2-lossless-text-blocks" };
const call = (id = "a") => ({ id, type: "function", function: { name: "lookup", arguments: '{"id":"L1001"}' } });
const imported = (role: string, index: number, content: string, suffix = "") => ({ role, content: `[source message ${index}; role=${role}${suffix}]\n${content}` });

describe("recorded message display adapter", () => {
  it("requires both declared encoding and exact scope, and explicit matching indices for links", () => {
    const input = { assessmentScope: WHOLE_TRAJECTORY_SCOPE, messages: [imported("user", 0, "Hello"), imported("assistant", 2, "Wrong index"), { role: "tool", content: "unannotated" }] };
    expect(isRecordedTrajectory(input, metadata)).toBe(true);
    expect(sourceMessageIndices(input, metadata)).toEqual([0]);
    expect(sourceMessageIndices(input, {})).toEqual([]);
    expect(sourceMessageIndices({ ...input, assessmentScope: "whole conversation" }, metadata)).toEqual([]);
    expect(sourceMessageIndices({ ...input, messages: [{ role: "tool", content: "[source message 0; role=user]\nWrong role" }] }, metadata)).toEqual([]);
  });
  it("reconstructs declared lossless blocks across prefix and JSON boundaries without changing evidence", () => {
    const value = imported("assistant", 0, `\nRecorded tool calls:\n${JSON.stringify([call()])}`);
    const original = value.content;
    const blocks = { ...value, content: [{ type: "text", text: original.slice(0, 8) }, { type: "text", text: original.slice(8, -5) }, { type: "text", text: original.slice(-5) }] };
    const frozen = JSON.stringify(blocks);
    expect(messageEvidence(blocks, 0, true)).toMatchObject({ sourceIndex: 0, content: "", calls: [call()] });
    expect(JSON.stringify(blocks)).toBe(frozen);
    expect(messageEvidence(blocks, 0, false).content).toEqual(blocks.content);
    const extras = { ...blocks, content: [{ type: "text", text: original, citations: ["preserve"] }] };
    expect(messageEvidence(extras, 0, true).content).toEqual(extras.content);
  });
  it("keeps malformed calls and unknown block shapes visible rather than guessing", () => {
    for (const text of ["{bad}", "null", "{}", "[]", '[{"type":"function","function":{"name":"lookup"}}]']) {
      const body = `\nRecorded tool calls:\n${text}`;
      const view = messageEvidence(imported("assistant", 0, body), 0, true);
      expect(view.calls).toBeUndefined();
      expect(view.content).toBe(body);
    }
    const content = [{ type: "image_url", url: "https://untrusted.invalid" }];
    expect(messageEvidence({ role: "user", content }, 0, true).content).toBe(content);
  });
  it("pairs only unique adjacent IDs; missing, duplicated and out-of-order evidence stays separate", () => {
    const assistant = { role: "assistant", content: null, tool_calls: [call()] };
    const result = { role: "tool", content: "result", tool_call_id: "a" };
    const user = { role: "user", content: "question" };
    expect(messageGroups([assistant, result], false).map(g => g.map(e => e.index))).toEqual([[0, 1]]);
    for (const messages of [[result, assistant], [assistant, user, result], [assistant, result, result], [assistant, assistant, result], [assistant, { ...result, tool_call_id: "missing" }]]) {
      expect(messageGroups(messages, false).every(g => g.length === 1)).toBe(true);
    }
    for (const id of ["", " ", "\t"]) {
      expect(messageGroups([{ ...assistant, tool_calls: [call(id)] }, { ...result, tool_call_id: id }], false).map(g => g.length)).toEqual([1, 1]);
    }
    const multi = [{ ...assistant, tool_calls: [call("a"), call("b")] }, result, { ...result, tool_call_id: "b" }];
    expect(messageGroups(multi, false).map(g => g.map(e => e.index))).toEqual([[0, 1, 2]]);
  });
});
