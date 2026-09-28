import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { contextualHref, observePageHeading, pageDocumentTitle, routeMetadata } from "../src/lib/route-metadata.js";
import { queueReviewUrl, reviewCaseCriterionPin, selectReviewCaseIds } from "../src/lib/exception-queue.js";

describe("workspace location", () => {
  it("matches specific routes before ancestors and normalizes trailing slashes", () => {
    expect(routeMetadata("/exceptions/")).toEqual(routeMetadata("/exceptions"));
    expect(routeMetadata("/skill/versions/v1").crumbs).toEqual([
      { label: "Skill", to: "/skill" }, { label: "Skill versions", to: "/skill/versions" }, { label: "Version" }
    ]);
    expect(routeMetadata("/human-truth/new/instruction").activePath).toBe("/human-truth");
    expect(routeMetadata("/human-truth/batches/b/items/i/resolve").crumbs.at(-1)?.label).toBe("Resolve item");
    expect(routeMetadata("/compare-runs").activePath).toBe("/datasets");
    expect(routeMetadata("/analyze").crumbs.at(-1)?.label).toBe("Analyze");
    expect(routeMetadata("/review-queues/q1").activePath).toBe("/review-queues");
    expect(routeMetadata("/review").activePath).toBe("/exceptions");
  });

  it("links case parents with criterion and exact evaluation pins, without leaking selection", () => {
    const search = "?criterionId=c1&from=exceptions&skillVersionId=old&criterionVersionId=cv1&caseId=other";
    expect(routeMetadata("/cases/a/make-test", search).crumbs).toEqual([
      { label: "Exceptions", to: "/exceptions?criterionId=c1" },
      { label: "Case", to: "/cases/a?criterionId=c1&from=exceptions&skillVersionId=old&criterionVersionId=cv1" },
      { label: "Make a test" }
    ]);
    expect(contextualHref("/skill/edit?version=old", search)).toBe("/skill/edit?version=old&criterionId=c1");
  });

  it("preserves a filtered Review all selection and each recorded definition without router state", () => {
    const href = queueReviewUrl([{ id: "a&b", criterionVersionId: "old / definition" }, { id: "second", criterionVersionId: "cv2" }], "?criterionId=c1&unrelated=discard", "Specific category");
    const search = new URL(href, "https://rubrist.example").searchParams;
    expect(search.get("criterionId")).toBe("c1");
    expect(search.get("cluster")).toBe("Specific category");
    expect(reviewCaseCriterionPin(search, "a&b")).toBe("old / definition");
    expect(reviewCaseCriterionPin(search, "second")).toBe("cv2");
    expect(search.has("unrelated")).toBe(false);
    expect(selectReviewCaseIds({ explicitCaseId: search.get("caseId"), explicitCaseIds: search.getAll("caseId"), stateCaseIds: undefined, exceptions: [{ id: "newer_case" }], categoryFilter: search.get("cluster") })).toEqual(["a&b", "second"]);
  });

  it("keeps 50 UUID cases with 50 distinct pins below a 6 KB request line", () => {
    const cases = Array.from({ length: 50 }, (_, i) => ({ id: `case_${String(i).padStart(8, "0")}-1234-1234-1234-123456789012`, criterionVersionId: `criterionv_${String(i).padStart(8, "0")}-1234-1234-1234-123456789012` }));
    const href = queueReviewUrl(cases, "?criterionId=criterion_12345678-1234-1234-1234-123456789012", "policy_grounding");
    expect(new TextEncoder().encode(href).length).toBeLessThan(6000);
    const params = new URL(href, "https://rubrist.example").searchParams;
    for (const item of cases) expect(reviewCaseCriterionPin(params, item.id)).toBe(item.criterionVersionId);
    const mixed = new URL(queueReviewUrl([{ id: "a", criterionVersionId: "old" }, { id: "b" }]), "https://rubrist.example").searchParams;
    expect(reviewCaseCriterionPin(mixed, "a")).toBe("old");
    expect(reviewCaseCriterionPin(mixed, "b")).toBeUndefined();
  });

  it("updates titles after async evidence, queue progress, history navigation, and disconnects", async () => {
    const dom = new JSDOM('<body><main id="main-content"></main></body>');
    vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
    const titles: string[] = [];
    const stop = observePageHeading(dom.window.document.body, (title) => titles.push(pageDocumentTitle(title || "Review", "WiCE")));
    const main = dom.window.document.querySelector("main")!;
    main.innerHTML = '<h1 aria-label="Case 1 of 8 · Review session">Eight cases</h1><h2>Evidence title</h2>';
    await Promise.resolve();
    expect(titles.at(-1)).toBe("Case 1 of 8 · Review session · WiCE · Rubrist");
    main.querySelector("h1")!.setAttribute("aria-label", "Case 3 of 8 · Review session");
    await Promise.resolve();
    expect(titles.at(-1)).toBe("Case 3 of 8 · Review session · WiCE · Rubrist");
    main.innerHTML = '<h1>Skill versions</h1>';
    await Promise.resolve();
    expect(titles.at(-1)).toBe("Skill versions · WiCE · Rubrist");
    stop();
    const count = titles.length;
    main.innerHTML = '<h1>Not observed</h1>';
    await Promise.resolve();
    expect(titles).toHaveLength(count);
    vi.unstubAllGlobals();
    dom.window.close();
  });
});
