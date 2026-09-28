import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProjectSettings } from "../src/lib/api.js";
const settings = { projectId: "project_1", name: "Project", mode: "bench", traceRetentionDays: 30 };
afterEach(() => vi.unstubAllGlobals());
describe("settings transport permissions", () => {
  it.each(["owner", "member"])("preserves explicit %s access", async (viewerRole) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...settings, viewerRole }), { headers: { "content-type": "application/json" } })));
    expect(await fetchProjectSettings()).toEqual({ ...settings, viewerRole });
  });
  it.each([undefined, "admin"])("rejects missing or invalid access metadata: %s", async (viewerRole) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...settings, viewerRole }))));
    await expect(fetchProjectSettings()).rejects.toThrow();
  });
});
