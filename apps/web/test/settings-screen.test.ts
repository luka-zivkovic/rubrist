import { JSDOM } from "jsdom";
import { act, createElement, useState, type ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Event", "Node", "localStorage"] as const) vi.stubGlobal(name, (dom.window as any)[name]);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router-dom");
const api = vi.hoisted(() => ({ fetchProjectSettings: vi.fn(), updateProjectSettings: vi.fn(), pruneExpiredTraces: vi.fn(), fetchJudgeKeys: vi.fn(), fetchJudgeProviders: vi.fn(), setJudgeKey: vi.fn(), deleteJudgeKey: vi.fn(), fetchApiKeys: vi.fn(), createApiKey: vi.fn(), revokeApiKey: vi.fn(), deleteProject: vi.fn(), selectProject: vi.fn(), createProject: vi.fn() }));
const state = vi.hoisted(() => ({ demoMode: false, canRememberKey: true, signOut: vi.fn(), purge: vi.fn(), clipboard: vi.fn() }));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/app-mode", () => ({ useAppMode: () => ({ demoMode: state.demoMode }) }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { name: "Owner", email: "owner@example.com" } } }), authClient: { signOut: state.signOut } }));
vi.mock("@/lib/journey", () => ({ forgetFirstProjectKey: vi.fn(), rememberFirstProjectKey: vi.fn(() => state.canRememberKey) }));
vi.mock("@/lib/production-calibration-api", () => ({ purgeProductionApiKeyRecords: state.purge }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: state.clipboard }));
vi.mock("../src/lib/clipboard.js", () => ({ copyTextToClipboard: state.clipboard }));
vi.mock("@/hooks/use-dialog-focus", async () => import("../src/hooks/use-dialog-focus.js"));
vi.mock("@/components/connect-agent-panel", () => ({ ConnectAgentPanel: ({ apiKey }: any) => createElement("div", { "data-agent-snippets": true }, apiKey ?? "key placeholder") }));
type Props = { children?: ReactNode } & Record<string, any>;
const Block = ({ children, ...props }: Props) => createElement("div", props, children);
vi.mock("@/components/ui/card", () => ({ Card: Block, CardHeader: Block, CardContent: Block, CardDescription: Block, CardTitle: ({ children, ...props }: Props) => createElement("h2", props, children) }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, variant: _variant, size: _size, ...props }: Props) => createElement("button", { type: "button", ...props }, children) }));
vi.mock("@/components/rubrist", () => ({ Eyebrow: Block, Chip: ({ children }: Props) => createElement("span", null, children), MarginNote: ({ children }: Props) => createElement("p", null, children), SectionHead: ({ title, sub, right }: Props) => createElement("header", null, createElement("h1", null, title), sub, right) }));
vi.mock("@/components/project-task", () => ({ CHOOSE_TASK_ERROR: "Choose", NAME_REQUIRED_ERROR: "Name", PROJECT_TASK_COPY: { bench: { cta: "Create project", busyCta: "Creating…" } }, ProjectTaskFields: ({ setMode, setName }: any) => createElement("button", { onClick: () => { setMode("bench"); setName("New project"); } }, "Set project draft") }));
const { NewProjectModal } = await import("../src/components/project-create.js");
const { SettingsScreen } = await import("../src/screens/settings.js");
const { parseRetentionDraft } = await import("../src/screens/settings/retention-card.js");
const { confirmProjectSwitch } = await import("../src/lib/project-switch.js");
const transport = await import("../src/lib/api/transport.js");
const settings = { projectId: "project_1", name: "Support", mode: "bench", traceRetentionDays: 30, viewerRole: "owner" };
const key = { id: "key_1", projectId: "project_1", name: "Workflow", keyPrefix: "rub_…", capability: "production_ingest", revokedAt: null, createdAt: "2026-09-28T00:00:00Z", lastUsedAt: null };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let router: ReturnType<typeof createMemoryRouter>;

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); state.demoMode = false; state.canRememberKey = true;
  api.fetchProjectSettings.mockResolvedValue(settings);
  api.fetchJudgeKeys.mockResolvedValue([]); api.fetchJudgeProviders.mockResolvedValue({ providers: [] }); api.fetchApiKeys.mockResolvedValue([]);
  api.updateProjectSettings.mockImplementation(async (input) => ({ ...settings, ...input }));
  api.setJudgeKey.mockImplementation(async (provider) => ({ provider, keyDisplay: "masked-key", createdAt: "2026-09-29T00:00:00Z" }));
  api.revokeApiKey.mockResolvedValue(undefined); api.deleteJudgeKey.mockResolvedValue(undefined);
  state.purge.mockResolvedValue({ decisions: 2, actions: 2, outcomes: 1 }); state.clipboard.mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); router?.dispose(); container.remove(); vi.restoreAllMocks(); });
afterAll(() => { vi.unstubAllGlobals(); dom.window.close(); });
function SettingsHarness({ withProjectModal }: { withProjectModal: boolean }) {
  const [showModal, setShowModal] = useState(withProjectModal);
  return createElement("div", null, createElement(SettingsScreen), showModal ? createElement(NewProjectModal, { onClose: () => setShowModal(false) }) : null);
}
async function mount(withProjectModal = false) {
  router = createMemoryRouter([{ path: "/settings", element: createElement(SettingsHarness, { withProjectModal }) }, { path: "/away", element: createElement("p", null, "Away") }], { initialEntries: ["/settings?criterionId=criterion_one"] });
  await act(async () => root.render(createElement(RouterProvider, { router })));
}
function button(text: string, scope: ParentNode = container) { const value = [...scope.querySelectorAll("button")].find((node) => node.textContent?.trim() === text); if (!value) throw new Error(`No button ${text}`); return value; }
async function click(text: string, scope?: ParentNode) { await act(async () => button(text, scope).click()); }
async function fill(id: string, value: string) {
  const node = container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
  const proto = node.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value); node.dispatchEvent(new window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

describe("settings interaction", () => {
  it("uses project permission without a dashboard and retains criterion links", async () => {
    await mount();
    expect(container.querySelector("#trace-retention-days")).not.toBeNull();
    expect(container.querySelector('a[href="/skill?criterionId=criterion_one"]')).not.toBeNull();
    expect(container.querySelector('nav[aria-label="Settings sections"]')?.textContent).toContain("Your account");
    expect(container.textContent).not.toContain("nightly sweep");
  });
  it.each(["member", "demo"])("keeps %s settings read-only and does not request owner-only API keys", async (mode) => {
    if (mode === "member") api.fetchProjectSettings.mockResolvedValue({ ...settings, viewerRole: "member" });
    else state.demoMode = true;
    await mount();
    expect(container.querySelectorAll("input, select")).toHaveLength(0);
    expect(api.fetchApiKeys).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Delete project…");
    expect(container.textContent).toContain(mode === "member" ? "ask an owner" : "Demo workspace");
    if (mode === "member") {
      expect(button("Sign out").disabled).toBe(false);
      expect(api.fetchJudgeKeys).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Only project owners can view or manage provider keys");
      expect(container.textContent).not.toContain("Retry provider keys");
    } else {
      expect(api.fetchJudgeKeys).toHaveBeenCalledOnce();
      expect(container.querySelector('[data-judge-key-row="anthropic"]')).not.toBeNull();
    }
  });
  it("fails closed and retries while keeping account access available", async () => {
    api.fetchProjectSettings.mockRejectedValueOnce(new Error("Access unavailable")); await mount();
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(button("Sign out")).toBeDefined();
    await click("Retry settings"); expect(container.querySelector("#trace-retention-days")).not.toBeNull();
  });
  it("separates retention save and deletion, retaining failed drafts", async () => {
    await mount(); await fill("trace-retention-days", "7");
    expect(button("Delete expired traces…").disabled).toBe(true);
    api.updateProjectSettings.mockRejectedValueOnce(new Error("Save unavailable")); await click("Save period");
    expect((container.querySelector("#trace-retention-days") as HTMLInputElement).value).toBe("7");
    expect(container.textContent).toContain("Save unavailable"); expect(api.pruneExpiredTraces).not.toHaveBeenCalled();
    await click("Save period"); expect(container.textContent).toContain("No traces were deleted");
    expect(button("Delete expired traces…").disabled).toBe(false);
    vi.mocked(window.confirm).mockReturnValue(false); await click("Delete expired traces…");
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("older than 7 days"));
    expect(api.pruneExpiredTraces).not.toHaveBeenCalled();
  });
  it("rejects invalid periods and makes indefinite retention non-destructive", async () => {
    await mount(); await fill("trace-retention-days", "-1"); await click("Save period");
    expect(api.updateProjectSettings).not.toHaveBeenCalled(); expect(container.querySelector('[aria-invalid="true"]')).not.toBeNull();
    await fill("trace-retention-days", ""); await click("Save period");
    expect(api.updateProjectSettings).toHaveBeenCalledWith({ traceRetentionDays: null });
    expect(button("Delete expired traces…").disabled).toBe(true);
  });
  it("asks before losing drafts on navigation, refresh or sign-out", async () => {
    await mount(); await fill("trace-retention-days", "14"); vi.mocked(window.confirm).mockReturnValue(false);
    await act(async () => { await router.navigate("/away"); }); expect(router.state.location.pathname).toBe("/settings");
    await click("Refresh"); expect(api.fetchProjectSettings).toHaveBeenCalledTimes(1);
    await click("Sign out"); expect(state.signOut).not.toHaveBeenCalled();
    expect((container.querySelector("#trace-retention-days") as HTMLInputElement).value).toBe("14");
    vi.mocked(window.confirm).mockReturnValue(true); await act(async () => { await router.navigate("/away"); });
    expect(container.textContent).toBe("Away");
  });
  it("keeps request scope unchanged when a dirty project switch is cancelled", async () => {
    transport.selectProject("project_1");
    await mount(); await fill("trace-retention-days", "14");
    vi.mocked(window.confirm).mockReturnValue(false);
    if (confirmProjectSwitch()) transport.selectProject("project_2");
    expect(transport.selectedProjectId()).toBe("project_1");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await transport.apiFetch("/api/project/settings", { method: "PATCH" });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("x-rubrist-project")).toBe("project_1");
    expect((container.querySelector("#trace-retention-days") as HTMLInputElement).value).toBe("14");
    vi.mocked(window.confirm).mockReturnValue(true);
    expect(confirmProjectSwitch()).toBe(true);
    const unload = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(false);
  });
  it.each([true, false])("preserves the old scope and pending project after cancelled creation navigation (key=%s)", async (hasKey) => {
    api.createProject.mockResolvedValue({ projectId: "project_2", apiKey: hasKey ? { ...key, key: "created-project-test-secret" } : null });
    await mount(true); await fill("trace-retention-days", "14");
    await click("Set project draft", document.body); vi.mocked(window.confirm).mockReturnValue(false);
    await click("Create project", document.body);
    expect(api.createProject).toHaveBeenCalledTimes(1);
    expect(api.selectProject).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(hasKey ? "created-project-test-secret" : "Project created — continue");
    await click(hasKey ? "I saved it — continue" : "Project created — continue", document.body);
    expect(api.selectProject).not.toHaveBeenCalled();
    expect(api.createProject).toHaveBeenCalledTimes(1);
    await click("Stay in current project", document.body);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect((container.querySelector("#trace-retention-days") as HTMLInputElement).value).toBe("14");
    expect(button("Save period").matches(":disabled")).toBe(false);
    expect(api.selectProject).not.toHaveBeenCalled();
  });
  it("allows staying after acknowledging an unstored project key and cancelling the switch", async () => {
    state.canRememberKey = false;
    api.createProject.mockResolvedValue({ projectId: "project_2", apiKey: { ...key, key: "unstored-project-key" } });
    await mount(true); await fill("trace-retention-days", "14");
    await click("Set project draft", document.body); await click("Create project", document.body);
    expect(document.body.textContent).not.toContain("Stay in current project");
    vi.mocked(window.confirm).mockReturnValue(false);
    await click("I saved it — continue", document.body);
    expect(api.selectProject).not.toHaveBeenCalled();
    await click("Stay in current project", document.body);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect((container.querySelector("#trace-retention-days") as HTMLInputElement).value).toBe("14");
    expect(button("Save period").matches(":disabled")).toBe(false);
    expect(api.createProject).toHaveBeenCalledTimes(1);
  });
  it("freezes forms and project switching while sign-out is pending, and restores failed sessions", async () => {
    const signOut = deferred<any>(); state.signOut.mockReturnValueOnce(signOut.promise);
    await mount(); await fill("trace-retention-days", "14"); await fill("api-key-name", "Workflow");
    await click("Sign out");
    expect(button("Save period").matches(":disabled")).toBe(true);
    expect(button("Create key").matches(":disabled")).toBe(true);
    await click("Save period"); await click("Create key");
    expect(api.updateProjectSettings).not.toHaveBeenCalled(); expect(api.createApiKey).not.toHaveBeenCalled();
    expect(confirmProjectSwitch()).toBe(false);
    await act(async () => signOut.resolve({ error: { message: "Session unavailable" } }));
    expect(button("Save period").matches(":disabled")).toBe(false);
    expect((container.querySelector("#trace-retention-days") as HTMLInputElement).value).toBe("14");
  });
  it("protects an uncopied one-time key until copy or explicit dismissal", async () => {
    api.createApiKey.mockResolvedValue({ ...key, key: "one-time-test-secret" }); await mount();
    await fill("api-key-name", "Workflow"); await click("Create key");
    vi.mocked(window.confirm).mockReturnValue(false); await click("Refresh");
    expect(api.fetchProjectSettings).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("one-time-test-secret");
    await act(async () => { await router.navigate("/away"); });
    expect(router.state.location.pathname).toBe("/settings");
    await click("Hide key");
    await act(async () => { await router.navigate("/away"); });
    expect(router.state.location.pathname).toBe("/away");
  });
  it("serializes provider changes and removes plaintext after a successful save", async () => {
    const save = deferred<any>(); api.setJudgeKey.mockReturnValueOnce(save.promise);
    await mount();
    const anthropic = container.querySelector('[data-judge-key-row="anthropic"]')!;
    const openai = container.querySelector('[data-judge-key-row="openai"]')!;
    await click("Add key", anthropic); await click("Add key", openai);
    await fill("provider-key-anthropic", "test-secret-one"); await fill("provider-key-openai", "test-secret-two");
    await click("Save key", anthropic); await click("Save key", openai);
    expect(api.setJudgeKey).toHaveBeenCalledTimes(1); expect(button("Save key", openai).disabled).toBe(true);
    expect(button("Refresh").disabled).toBe(true);
    await act(async () => save.resolve({ provider: "anthropic", keyDisplay: "masked-key", createdAt: "2026-09-29T00:00:00Z" }));
    expect(container.querySelector("#provider-key-anthropic")).toBeNull();
    expect(container.innerHTML).not.toContain("test-secret-one");
    expect((container.querySelector("#provider-key-openai") as HTMLInputElement).value).toBe("test-secret-two");
    expect(button("Save key", openai).disabled).toBe(false);
  });
  it("does not turn a key-list failure into an empty writable list", async () => {
    api.fetchJudgeKeys.mockRejectedValueOnce(new Error("Key list unavailable")); await mount();
    expect(container.querySelector('[data-judge-key-row="anthropic"]')).toBeNull();
    await click("Retry provider keys"); expect(container.querySelector('[data-judge-key-row="anthropic"]')).not.toBeNull();
  });
  it("keeps ingest-only keys out of judging snippets and clears the one-time key", async () => {
    api.createApiKey.mockResolvedValue({ ...key, key: "one-time-test-secret" }); await mount();
    await fill("api-key-name", "Workflow"); await fill("api-key-capability", "production_ingest"); await click("Create key");
    expect(api.createApiKey).toHaveBeenCalledWith("Workflow", "production_ingest");
    expect(container.querySelector("[data-agent-snippets]")).toBeNull();
    expect(container.textContent).toContain("POST /api/v1/production-decisions");
    expect(button("Create key").disabled).toBe(true);
    await click("Copy key"); expect(state.clipboard).toHaveBeenCalledWith("one-time-test-secret");
    await click("Hide key"); expect(container.textContent).not.toContain("one-time-test-secret");
    expect(localStorage.length).toBe(0);
  });
  it("guards revoke and purge requests and preserves data until explicit purge", async () => {
    api.fetchApiKeys.mockResolvedValue([key]); const revoke = deferred<void>(); api.revokeApiKey.mockReturnValue(revoke.promise);
    await mount(); await click("Revoke…");
    expect(button("Revoking…").disabled).toBe(true); expect(state.purge).not.toHaveBeenCalled();
    await act(async () => revoke.resolve()); expect(container.textContent).toContain("Existing records were retained");
    vi.mocked(window.confirm).mockReturnValue(false); await click("Purge records…"); expect(state.purge).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true); await click("Purge records…");
    expect(state.purge).toHaveBeenCalledTimes(1); expect(button("Records purged").disabled).toBe(true);
  });
});

describe("retention input", () => {
  it.each(["0", "-1", "3651", "1.5", "1e2", "unknown"])("rejects %s", (value) => expect(parseRetentionDraft(value)).toBeUndefined());
  it("accepts whole days and blank indefinite", () => { expect(parseRetentionDraft(" 30 ")).toBe(30); expect(parseRetentionDraft(" ")).toBeNull(); });
});
