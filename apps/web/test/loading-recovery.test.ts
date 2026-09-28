import { JSDOM } from "jsdom";
import { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageLoading } from "../src/components/page-loading.js";
import { CheckWait, LONG_CHECK_WAIT_MS } from "../src/components/check-wait.js";

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/review?caseId=case1&criterionId=criterion1" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "Node", "MutationObserver"] as const) {
  vi.stubGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
}
Object.defineProperty(window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
const { createRoot } = await import("react-dom/client");
const state = vi.hoisted(() => ({
  dashboard: null, loading: false, error: "Server failure" as string | null,
  errorKind: "unavailable" as string | null, errorStatus: 500 as number | null,
  reload: vi.fn(async () => {}), refresh: vi.fn(async () => {}),
  pathname: "/exceptions", criteriaLoading: false
}));
type Props = { children?: ReactNode; [key: string]: unknown };
const Box = ({ children }: Props) => createElement("div", null, children);
vi.mock("react-router-dom", () => ({
  Link: ({ to, children }: Props) => createElement("a", { href: to as string }, children),
  Outlet: () => createElement("section", { "data-route": "queue" }, "Queue owns its loading and error state"),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: state.pathname, search: "?caseId=case1&criterionId=criterion1" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()]
}));
vi.mock("@/lib/dashboard-context", () => ({ DashboardProvider: Box, useDashboard: () => state }));
vi.mock("@/lib/criterion-context", () => ({ CriterionProvider: Box, useCriterion: () => ({
  choices: [], selectedCriterionId: "criterion1", selectedChoice: null,
  selectionRequired: false, selectCriterion: vi.fn(), loading: state.criteriaLoading
}) }));
vi.mock("@/lib/criterion-selection", async () => import("../src/lib/criterion-selection.js"));
vi.mock("@/lib/resolved", async () => import("../src/lib/resolved.js"));
vi.mock("@/components/save-queue-modal", () => ({ SaveQueueModal: () => null }));
vi.mock("@/lib/app-mode", () => ({ useAppMode: () => ({ demoMode: false }) }));
vi.mock("../src/components/layout/sidebar.js", () => ({ Sidebar: () => null }));
vi.mock("../src/components/layout/topbar.js", () => ({
  Topbar: ({ crumbs }: Props) => createElement("nav", null, ...(crumbs as ReactNode[])), TopbarPill: Box
}));
vi.mock("@/components/skip-link", () => ({ SkipLink: () => null }));
vi.mock("@/components/import-trace-launcher", () => ({ ImportTraceLauncher: () => null }));
vi.mock("@/components/project-create", () => ({ NoProjectLanding: () => createElement("div", null, "No project") }));
vi.mock("@/screens/criteria", () => ({ CriterionPicker: () => null }));
vi.mock("@/screens/login", () => ({ LoginScreen: () => createElement("form", { "aria-label": "Sign in" }, "Sign in") }));
vi.mock("@/screens/system", async () => import("../src/screens/system.js"));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, variant: _v, size: _s, ...props }: Props) => createElement("button", props, children) }));
vi.mock("@/components/ui/card", () => ({ Card: Box, CardHeader: Box, CardTitle: Box, CardDescription: Box }));
vi.mock("@/components/ui/table", () => ({ Table: Box }));
vi.mock("@/components/row-action", () => ({ RowLink: Box }));
vi.mock("@/components/rubrist", () => ({
  EmptyGlyph: () => null,
  EmptyShell: ({ title, body, primary, secondary }: Props) => createElement("section", null, createElement("h1", null, title as ReactNode), body as ReactNode, primary as ReactNode, secondary as ReactNode)
}));
vi.mock("@/lib/api", () => ({ fetchDisagreements: vi.fn(), fetchProjectVerdicts: vi.fn(), fetchGoldenSet: vi.fn() }));
vi.mock("@/lib/criterion-scope", async () => import("../src/lib/criterion-scope.js"));
vi.mock("@/lib/exception-queue", async () => import("../src/lib/exception-queue.js"));
vi.mock("@/lib/journey", async () => import("../src/lib/journey.js"));
vi.mock("@/lib/utils", () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(" ") }));
const { RootLayout } = await import("../src/components/layout/root-layout.js");
const { ExceptionsScreen } = await import("../src/screens/exceptions.js");
const { ApiUnavailableScreen } = await import("../src/screens/system.js");
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.loading = false; state.errorKind = "unavailable"; state.errorStatus = 500; state.error = "Server failure"; state.criteriaLoading = false; state.pathname = "/exceptions";
  state.reload.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
const render = async (element: ReactNode) => { await act(async () => root.render(element)); };

it("an expired API session reaches sign-in without losing the route", async () => {
  state.errorKind = "unauthorized"; state.errorStatus = 401;
  const before = window.location.href;
  await render(createElement(RootLayout));
  expect(container.textContent).toContain("Your session expired");
  expect(container.querySelector('form[aria-label="Sign in"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Loading");
  expect(window.location.href).toBe(before);
});

it("the shell preserves the queue route on dashboard failure and names the unavailable project", async () => {
  await render(createElement(RootLayout));
  expect(container.querySelector('[data-route="queue"]')).not.toBeNull();
  expect(container.querySelector("nav")?.textContent).toContain("Project unavailable");
  expect(container.querySelector("nav")?.textContent).not.toContain("Rubrist /");
});

it("the queue exposes its own server error and working retry instead of empty success", async () => {
  await render(createElement(ExceptionsScreen));
  expect(container.textContent).toContain("server returned an error while loading the review queue");
  expect(container.textContent).toContain("HTTP 500");
  expect(container.textContent).not.toContain("internet");
  expect(container.textContent).not.toContain("Queue cleared");
  await act(async () => container.querySelector("button")!.click());
  expect(state.reload).toHaveBeenCalledTimes(1);
});

it("an unknown transport failure does not fabricate an HTTP or internet diagnosis", async () => {
  await render(createElement(ApiUnavailableScreen, { retry: state.reload }));
  expect(container.textContent).toContain("Couldn't load this page");
  expect(container.textContent).not.toContain("HTTP");
  expect(container.textContent).not.toContain("INTERNET_DISCONNECTED");
});

it("a refused read offers no ineffective retry", async () => {
  await render(createElement(ApiUnavailableScreen, { status: 403, retry: state.reload }));
  expect(container.textContent).toContain("HTTP 403");
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).not.toContain("Try again");
});

it("loading skeletons announce a pending read without invented counts", async () => {
  await render(createElement(PageLoading, { title: "Loading versions", shape: "list" }));
  expect(container.querySelector('[role="status"]')?.getAttribute("aria-busy")).toBe("true");
  expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
  expect(container.textContent).toBe("Loading versions");
});

it("a long wait exposes elapsed save time and safe navigation without fabricating failure", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T12:00:00Z"));
  await render(createElement(CheckWait, { createdAt: "2026-09-28T12:00:00Z" }));
  expect(container.textContent).toContain("Version saved 0s ago");
  await act(async () => vi.advanceTimersByTimeAsync(LONG_CHECK_WAIT_MS));
  expect(container.textContent).toContain("Version saved 2 min ago");
  expect(container.textContent).toContain("Still waiting for the recorded check result");
  expect(container.textContent).toContain("safe to leave");
  expect(container.textContent).not.toMatch(/failed|passed|timed out/i);
  await render(createElement(CheckWait, { createdAt: "2026-09-28T12:00:00Z", stopped: true }));
  expect(container.textContent).not.toContain("keeps checking");
  expect(vi.getTimerCount()).toBe(0);
});
