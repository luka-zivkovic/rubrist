import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ")
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() })
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { name: "Owner", email: "owner@example.com" } } })
}));
vi.mock("@/lib/app-mode", () => ({
  useAppMode: () => ({ demoMode: false })
}));
vi.mock("@/lib/criterion-context", () => ({
  useCriterion: () => ({ href: (path: string) => `${path}?criterionId=criterion_one` })
}));
vi.mock("@/lib/api", () => ({
  fetchProjects: vi.fn(),
  selectProject: vi.fn(),
  selectedProjectId: () => null
}));
vi.mock("@/components/project-create", () => ({
  NewProjectModal: () => null
}));
vi.mock("@/components/rubrist-brand", () => ({
  RubristBrand: () => createElement("span", null, "rubrist")
}));

const { Sidebar } = await import("../src/components/layout/sidebar.js");

function renderSidebar(bench: boolean, path = "/"): string {
  return renderToStaticMarkup(createElement(
    MemoryRouter,
    { initialEntries: [path] },
    createElement(Sidebar, { bench, exceptionsCount: 3 })
  ));
}

describe("single workspace navigation", () => {
  it.each([false, true])("ignores every historical preference (bench=%s)", (bench) => {
    const dom = new JSDOM("", { url: "https://rubrist.example" });
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    try {
      const baseline = renderSidebar(bench);
      for (const mode of ["pm", "dev", "exec", "unknown"]) {
        dom.window.localStorage.setItem("rubrist.mode", mode);
        dom.window.document.documentElement.className = mode === "dev" ? "dev" : "";
        expect(renderSidebar(bench)).toBe(baseline);
      }
      const doc = new JSDOM(baseline).window.document;
      const links = [...doc.querySelectorAll('nav a')].map((link) => link.getAttribute("href"));
      for (const path of ["/", "/datasets", "/exceptions", "/review-queues", "/criteria", "/skill", "/golden", "/analyze", "/human-truth", "/reliability", "/production-calibration", "/integrations", "/settings"]) {
        expect(links).toContain(`${path}?criterionId=criterion_one`);
      }
      expect(links.includes("/traces?criterionId=criterion_one")).toBe(!bench);
      expect(new Set(links).size).toBe(links.length);
      expect(doc.body.textContent).not.toMatch(/Workspace display|Guided|Technical|Summary|1 · Define/);
      expect(doc.body.textContent).toContain("Human truth · governed");
      expect(doc.body.textContent).toContain("Review sessions · ungoverned");
      expect(doc.body.textContent).toContain("Ungoverned diagnostics");
    } finally {
      vi.unstubAllGlobals();
      dom.window.close();
    }
  });

  it.each([false, true])("highlights saved session details directly (bench=%s)", (bench) => {
    const doc = new JSDOM(renderSidebar(bench, "/review-queues/queue_one?criterionId=criterion_one")).window.document;
    const active = doc.querySelectorAll('a[aria-current="page"]');
    expect(active).toHaveLength(1);
    expect(active[0]?.getAttribute("href")).toBe("/review-queues?criterionId=criterion_one");
  });
});
