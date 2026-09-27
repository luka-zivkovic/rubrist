import { JSDOM } from "jsdom";
import { StrictMode, act, createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The hook imports app aliases (`@/...`) that only the node transform lets
// these mocks replace, so this test runs in node with a jsdom window installed
// as globals before React DOM loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "Node"] as const) {
  vi.stubGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
}
const { createRoot } = await import("react-dom/client");

vi.mock("@/lib/load-error", async () => import("../src/lib/load-error.js"));
const { useSectionRead } = await import("../src/hooks/use-section-read.js");

// Reads that settle only when the test says so, in any order.
function deferredReads() {
  const pending = new Map<string, Array<{ resolve: (value: string) => void; reject: (error: Error) => void }>>();
  return {
    read: (key: string) => () => new Promise<string>((resolve, reject) => {
      pending.set(key, [...(pending.get(key) ?? []), { resolve, reject }]);
    }),
    settle: (key: string, value: string | Error) => {
      const next = pending.get(key)?.shift();
      if (!next) throw new Error(`no pending read for ${key}`);
      if (value instanceof Error) next.reject(value);
      else next.resolve(value);
    },
    count: (key: string) => pending.get(key)?.length ?? 0
  };
}

let container: HTMLDivElement;
let root: Root;
let seen: string[];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  seen = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Probe({ sectionKey, read }: { sectionKey: string | null; read: ((key: string) => () => Promise<string>) }) {
  const section = useSectionRead(sectionKey, sectionKey === null ? null : read(sectionKey));
  const label = section.status === "loaded"
    ? `loaded:${section.data}`
    : section.status === "failed"
      ? `failed:${section.failure.message}${section.retrying ? ":retrying" : ""}`
      : section.status;
  seen.push(`${sectionKey ?? "null"}=${label}`);
  return createElement("button", { onClick: section.retry }, label);
}

async function show(sectionKey: string | null, read: (key: string) => () => Promise<string>) {
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe, { sectionKey, read }))));
}

const text = () => container.textContent;

describe("useSectionRead", () => {
  it("never lets a read for an older key land on the current one", async () => {
    const reads = deferredReads();
    await show("a", reads.read);
    await show("b", reads.read);
    expect(text()).toBe("loading");

    await act(async () => reads.settle("b", "B"));
    expect(text()).toBe("loaded:B");
    // StrictMode ran the effect twice for "a"; neither read may land now.
    await act(async () => {
      while (reads.count("a") > 0) reads.settle("a", "A");
    });
    expect(text()).toBe("loaded:B");
  });

  it("keeps a failure in place while its retry is in flight", async () => {
    const reads = deferredReads();
    await show("a", reads.read);
    await act(async () => {
      while (reads.count("a") > 0) reads.settle("a", new Error("Judge Card request failed: 503"));
    });
    expect(text()).toBe("failed:Judge Card request failed: 503");

    await act(async () => container.querySelector("button")!.click());
    expect(text()).toBe("failed:Judge Card request failed: 503:retrying");

    await act(async () => {
      while (reads.count("a") > 0) reads.settle("a", "A");
    });
    expect(text()).toBe("loaded:A");
  });

  it("starts fresh when a key comes back after the page stopped reading", async () => {
    const reads = deferredReads();
    await show("a", reads.read);
    await act(async () => {
      while (reads.count("a") > 0) reads.settle("a", "old");
    });
    expect(text()).toBe("loaded:old");

    await show(null, reads.read);
    expect(text()).toBe("idle");
    seen = [];
    await show("a", reads.read);

    // The old read is never shown again for the returning key.
    expect(seen).not.toContain("a=loaded:old");
    expect(text()).toBe("loading");
    await act(async () => {
      while (reads.count("a") > 0) reads.settle("a", "new");
    });
    expect(text()).toBe("loaded:new");
  });
});
