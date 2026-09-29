export interface RouteCrumb { label: string; to?: string }
export interface RouteMetadata { crumbs: RouteCrumb[]; activePath: string }

// Shared product vocabulary; route identities remain stable.
export function routeMetadata(pathname: string, search = "", bench = false): RouteMetadata {
  const path = pathname.replace(/\/+$/, "") || "/";
  const names: Record<string, string> = {
    "/": "Overview", "/traces": "Traces", "/exceptions": "Review queue",
    "/reliability": "Reliability", "/production-calibration": "Production calibration",
    "/review-queues": "Saved review queues", "/criteria": "Criteria", "/analyze": "Analyze",
    "/human-truth": "Human truth", "/skill": "Evaluator", "/first-result": "First assessment",
    "/golden": "Golden set", "/datasets": bench ? "Cases & evaluation runs" : "Datasets",
    "/integrations": "Integrations", "/settings": "Settings"
  };
  const parent = (to: string): RouteCrumb => ({ label: names[to]!, to: contextualHref(to, search) });
  const result = (activePath: string, crumbs: RouteCrumb[]): RouteMetadata => ({ activePath, crumbs });
  if (names[path]) return result(path, [{ label: names[path]! }]);
  if (path === "/review") return result("/exceptions", [parent("/exceptions"), { label: "Review" }]);
  const caseMatch = path.match(/^\/cases\/([^/]+)(\/make-test)?$/);
  if (caseMatch) {
    const origin = new URLSearchParams(search).get("from") === "exceptions" ? "/exceptions" : "/traces";
    const crumbs = [parent(origin), { label: "Case", ...(caseMatch[2] ? { to: contextualHref(`/cases/${caseMatch[1]}`, search, ["from", "skillVersionId", "criterionVersionId"]) } : {}) }];
    if (caseMatch[2]) crumbs.push({ label: "Make a test" });
    return result(origin, crumbs);
  }
  if (/^\/tests\/[^/]+\/evidence$/.test(path)) return result("/datasets", [parent("/datasets"), { label: "Test evidence" }]);
  if (path === "/compare-runs") return result("/datasets", [parent("/datasets"), { label: "Compare runs" }]);
  if (path.startsWith("/skill/")) {
    const crumbs = [parent("/skill")];
    if (path.startsWith("/skill/versions")) {
      crumbs.push({ label: "Evaluator versions", ...(path !== "/skill/versions" ? { to: contextualHref("/skill/versions", search) } : {}) });
      if (path !== "/skill/versions") crumbs.push({ label: "Version" });
    } else crumbs.push({ label: path === "/skill/edit" ? "Edit skill" : path === "/skill/compare" ? "Compare versions" : "Evaluator" });
    return result("/skill", crumbs);
  }
  if (path.startsWith("/human-truth/")) return result("/human-truth", [parent("/human-truth"), { label: path.endsWith("/resolve") ? "Resolve item" : "Create human truth" }]);
  if (/^\/review-queues\/[^/]+$/.test(path)) return result("/review-queues", [parent("/review-queues"), { label: "Review queue" }]);
  return result("", [{ label: "Page not found" }]);
}

// Carry only route-relevant scope. Never duplicate '?' or leak a case selection
// into an unrelated page. Explicit evaluator/definition pins are opt-in.
export function contextualHref(path: string, search: string, keys: string[] = []): string {
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  const source = new URLSearchParams(search);
  for (const key of ["criterionId", ...keys]) {
    if (!params.has(key) && source.has(key)) params.set(key, source.get(key)!);
  }
  return `${pathname}${params.size ? `?${params}` : ""}`;
}

export function pageDocumentTitle(page: string, project: string): string {
  return [...new Set([page.trim(), project.trim(), "Rubrist"].filter(Boolean))].join(" · ");
}

// Semantic page headings supply dynamic names and the review player's position.
// Observing the content also catches async loads and browser history navigation.
export function observePageHeading(root: HTMLElement, onTitle: (title: string) => void): () => void {
  const update = () => {
    const heading = root.querySelector("#main-content h1");
    onTitle(heading?.getAttribute("aria-label") || heading?.textContent?.trim() || "");
  };
  update();
  const observer = new MutationObserver(update);
  observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-label"] });
  return () => observer.disconnect();
}
