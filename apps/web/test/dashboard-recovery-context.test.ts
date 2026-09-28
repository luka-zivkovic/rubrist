import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api/transport.js";
const dom = new JSDOM("<!doctype html><body></body>");
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "Node"] as const) vi.stubGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
const { createRoot } = await import("react-dom/client");
const api = vi.hoisted(() => ({ fetchDashboard: vi.fn(), selectedProjectId: vi.fn(() => null), selectProject: vi.fn() }));
vi.mock("@/lib/api", async () => ({ ...api, ApiError: (await import("../src/lib/api/transport.js")).ApiError }));
vi.mock("@/lib/criterion-context", () => ({ useCriterion: () => ({ selectedCriterionId: "criterion1", loading: false, selectionRequired: false }) }));
const { DashboardProvider, useDashboard } = await import("../src/lib/dashboard-context.js");
let state: ReturnType<typeof useDashboard>;
function Consumer() { state = useDashboard(); return createElement("div", null, `${state.loading}:${state.errorKind}:${state.errorStatus}:${state.dashboard ? "loaded" : "missing"}`); }
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); api.fetchDashboard.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function mount() { await act(async () => root.render(createElement(DashboardProvider, null, createElement(Consumer)))); }
const loaded = { skill: { criterionId: "criterion1" }, project: { name: "Test" } };

it("propagates the actual HTTP status and recovers on explicit retry", async () => {
  api.fetchDashboard.mockRejectedValueOnce(new ApiError("Server failure", 503)).mockResolvedValue(loaded);
  await mount();
  expect(container.textContent).toBe("false:unavailable:503:missing");
  await act(async () => state.reload());
  expect(container.textContent).toBe("false:null:null:loaded");
});

it("a background401 clears stale project data instead of leaving an apparently signed-in shell", async () => {
  api.fetchDashboard.mockResolvedValueOnce(loaded).mockRejectedValueOnce(new ApiError("Session expired", 401));
  await mount();
  expect(state.dashboard).not.toBeNull();
  await act(async () => state.refresh());
  expect(container.textContent).toBe("false:unauthorized:401:missing");
});

it("a transient background failure retains last-known data without inventing a terminal result", async () => {
  api.fetchDashboard.mockResolvedValueOnce(loaded).mockRejectedValueOnce(new ApiError("Temporarily unavailable", 503));
  await mount();
  await act(async () => state.refresh());
  expect(container.textContent).toBe("false:null:null:loaded");
});
