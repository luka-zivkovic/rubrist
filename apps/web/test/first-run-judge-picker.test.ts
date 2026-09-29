// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/screens/skill-edit/binding-settings.js", () => ({ BindingSettings: () => createElement("input", { "aria-label": "Detailed setting" }) }));
const { FirstRunJudgePicker } = await import("../src/components/first-run-judge-picker.js");
type Props = ComponentProps<typeof FirstRunJudgePicker>;
let container: HTMLDivElement;
let root: Root;
let props: Props;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  props = {
    provider: "anthropic", providers: [
      { provider: "anthropic", label: "Anthropic", available: true, credentialSource: "project", modelSelection: "catalog" },
      { provider: "custom", label: "Custom", available: true, credentialSource: "project", modelSelection: "custom" },
      { provider: "openrouter", label: "OpenRouter", available: false, credentialSource: null, modelSelection: "catalog" }
    ], modelId: "saved-model", modelVersion: "pin-1", baseUrl: "https://example.test/v1", models: [],
    loading: false, error: null, disabled: false, temperature: "", temperatureValid: true, canCheck: true,
    picker: { blockingProblems: [], checkPending: false, temperaturePending: false, checkError: null, report: null } as unknown as Props["picker"],
    onProvider: vi.fn(), onModel: vi.fn(), onBaseUrl: vi.fn()
  };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = () => act(async () => root.render(createElement(FirstRunJudgePicker, props)));
async function change(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    if (element instanceof HTMLInputElement) Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event(element instanceof HTMLInputElement ? "input" : "change", { bubbles: true }));
  });
}
it("offers configured providers and forwards custom model, version and endpoint choices", async () => {
  await render();
  const providers = container.querySelector<HTMLSelectElement>('[aria-label="Judge provider"]')!;
  expect([...providers.options].map(option => option.value)).toEqual(["anthropic", "custom"]);
  await change("Judge provider", "custom");
  expect(props.onProvider).toHaveBeenCalledWith("custom");
  props.provider = "custom"; await render();
  await change("Custom judge model ID", "new-model");
  expect(props.onModel).toHaveBeenCalledWith("new-model", "new-model");
  await change("Custom judge model version", "pin-2");
  expect(props.onModel).toHaveBeenCalledWith("saved-model", "pin-2");
  await change("Custom judge base URL", "https://other.test/v1");
  expect(props.onBaseUrl).toHaveBeenCalledWith("https://other.test/v1");
});
it("opens actionable check errors and disables all controls during creation", async () => {
  props.picker.checkError = "Provider unavailable";
  props.disabled = true;
  await render();
  expect(container.querySelector("details")!.open).toBe(true);
  expect(container.querySelector('[role="status"]')!.textContent).toContain("could not finish");
  expect(container.querySelector("fieldset")!.disabled).toBe(true);
  expect(container.querySelector('[aria-label="Detailed setting"]')!.matches(":disabled")).toBe(true);
});
