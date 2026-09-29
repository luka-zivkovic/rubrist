import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { Button } from "@/components/ui/button";
import { SkipLink } from "@/components/skip-link";
import { ImportTraceLauncher } from "@/components/import-trace-launcher";
import { NoProjectLanding } from "@/components/project-create";
import { SectionLoadError } from "../rubrist/load-error.js";
import { retryableStatus } from "../../lib/load-error.js";
import { LoginScreen } from "@/screens/login";
import { PageLoading } from "../page-loading.js";
import { useAppMode } from "@/lib/app-mode";
import { DashboardProvider, useDashboard } from "@/lib/dashboard-context";
import { CriterionProvider, useCriterion } from "@/lib/criterion-context";
import { routeRequiresCriterionSelection } from "@/lib/criterion-selection";
import { CriterionPicker } from "@/screens/criteria";
import { contextualHref, observePageHeading, pageDocumentTitle, routeMetadata } from "../../lib/route-metadata.js";
import { isBench } from "@/lib/journey";

export function RootLayout() {
  return (
    <CriterionProvider>
      <DashboardProvider>
        <RootLayoutInner />
      </DashboardProvider>
    </CriterionProvider>
  );
}

function RootLayoutInner() {
  const location = useLocation();
  const { dashboard, loading, errorKind, errorStatus, reload } = useDashboard();
  const {
    choices,
    loading: criteriaLoading,
    selectedCriterionId,
    selectedChoice,
    selectCriterion,
    selectionRequired,
  } = useCriterion();
  const { demoMode } = useAppMode();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationTriggerRef = useRef<HTMLButtonElement>(null);

  const bench = dashboard ? isBench(dashboard.project) : false;
  const projectName = dashboard?.project.name ?? (errorKind ? "Project unavailable" : loading ? "Loading project…" : "Project");
  // The bench subtitle doubles as the persistent honesty marker: no
  // production traces back these numbers, only supplied examples.
  const projectSource = dashboard
    ? bench
      ? `Judge a dataset · ${dashboard.project.importedTraceCount.toLocaleString()} examples · no production traces`
      : `Judge live traces · ${dashboard.project.traceProvider} · ${dashboard.project.importedTraceCount.toLocaleString()} traces`
    : "—";
  // null until the dashboard loads, and after it fails: an unknown count is
  // shown as unknown, never as zero.
  const exceptionsCount = dashboard?.exceptionsTotal ?? null;
  const importedTotal = dashboard?.project.importedTraceCount ?? null;
  const criterionSelectionRequiredForRoute = routeRequiresCriterionSelection(location.pathname);
  const showCriterionPicker = selectionRequired && criterionSelectionRequiredForRoute;

  const route = useMemo(() => routeMetadata(location.pathname, location.search, bench), [location.pathname, location.search, bench]);
  const [pageHeading, setPageHeading] = useState("");
  useEffect(() => observePageHeading(document.body, setPageHeading), [location.pathname]);
  const pageTitle = pageHeading || route.crumbs.at(-1)?.label || "Rubrist";
  useEffect(() => { document.title = pageDocumentTitle(pageTitle, projectName); }, [pageTitle, projectName]);
  const crumbs = [
    <Link key="project" to={contextualHref("/", location.search)}>{projectName}</Link>,
    ...route.crumbs.map((crumb, index) => crumb.to
      ? <Link key={crumb.to} to={crumb.to}>{crumb.label}</Link>
      : <span key={index}>{pageHeading || crumb.label}</span>)
  ];

  useEffect(() => {
    setNavigationOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!navigationOpen) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setNavigationOpen(false);
      window.requestAnimationFrame(() => navigationTriggerRef.current?.focus());
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => document.getElementById("workspace-navigation")?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [navigationOpen]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeDrawerAtDesktop = () => {
      if (desktop.matches) setNavigationOpen(false);
    };
    closeDrawerAtDesktop();
    desktop.addEventListener("change", closeDrawerAtDesktop);
    return () => desktop.removeEventListener("change", closeDrawerAtDesktop);
  }, []);

  // P0-2 shell taxonomy — these are different states and get different
  // screens. "Empty project" is NOT here: that's the day-0 journey, handled
  // by the screens themselves. An API 401 can precede the session hook refresh.
  // (Hooks above must run unconditionally — keep these returns below them.)
  if (!dashboard && errorKind === "no-project") {
    return <NoProjectLanding />;
  }
  if (errorKind === "unauthorized") {
    // Render sign-in at the current URL. Successful login reloads that exact
    // location, preserving the case/version and criterion query selection.
    return <><p role="alert" className="px-6 pt-6 text-center">Your session expired. Sign in again to continue.</p><LoginScreen /></>;
  }

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[256px_minmax(0,1fr)]">
      <SkipLink />
      {navigationOpen ? (
        <button
          type="button"
          aria-label="Close workspace navigation"
          aria-hidden="true"
          tabIndex={-1}
          className="fixed inset-0 z-30 cursor-default bg-ink/35 lg:hidden"
          onClick={() => {
            setNavigationOpen(false);
            window.requestAnimationFrame(() => navigationTriggerRef.current?.focus());
          }}
        />
      ) : null}
      <Sidebar
        projectName={projectName}
        projectSource={projectSource}
        exceptionsCount={exceptionsCount ?? 0}
        bench={bench}
        mobileOpen={navigationOpen}
        onMobileClose={() => setNavigationOpen(false)}
      />
      <main id="main-content" tabIndex={-1} inert={navigationOpen} className="flex min-w-0 flex-col outline-none">
        <Topbar
          crumbs={crumbs}
          navigationOpen={navigationOpen}
          navigationTriggerRef={navigationTriggerRef}
          onOpenNavigation={() => setNavigationOpen(true)}
          right={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
              {demoMode ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-sm border border-gold-tint bg-ambig-bg px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-gold"
                  title="Running on in-memory demo fixtures — no auth, data resets on API restart."
                >
                  Demo mode
                </span>
              ) : null}
              {dashboard ? (bench ? <AddExamplesLauncher /> : <ImportTraceLauncher />) : null}
              {choices.length > 1 && selectedCriterionId ? (
                <label className="flex min-w-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
                  Criterion
                  <select
                    aria-label="Selected criterion"
                    value={selectedCriterionId}
                    onChange={(event) => selectCriterion(event.target.value)}
                    className="min-w-0 max-w-48 rounded-sm border border-rule bg-card px-2 py-1 text-[11px] normal-case tracking-normal text-ink"
                  >
                    {choices.map((choice) => (
                      <option key={choice.criterion.id} value={choice.criterion.id}>{choice.name}</option>
                    ))}
                  </select>
                </label>
              ) : selectedChoice ? (
                <span className="font-mono text-[10px] text-ink-3">criterion · {selectedChoice.name}</span>
              ) : null}
              <div className="hidden font-mono text-[10.5px] text-ink-3 xl:block">
                <b className="font-medium text-ink">{importedTotal === null ? "—" : importedTotal.toLocaleString()}</b> {bench ? "examples" : "traces imported"}
                <span className="text-ink-3"> · </span>
                <b className={`font-medium ${exceptionsCount ? "text-signal" : "text-ink"}`}>{exceptionsCount ?? "—"}</b> waiting for review
              </div>

            </div>
          }
        />
        <div className="min-w-0 w-full max-w-none px-5 pt-7 pb-20 sm:px-8 xl:px-12 xl:pt-9">
          {!dashboard && errorKind === "unavailable" && !["/", "/exceptions", "/review"].includes(location.pathname) ? (
            <SectionLoadError
              title="Project overview unavailable"
              failure={{ message: errorStatus ? `Request returned HTTP ${errorStatus}. Other page data can still load independently.` : "The project summary could not be loaded. Other page data can still load independently.", retryable: errorStatus == null || retryableStatus(errorStatus) }}
              onRetry={() => void reload()}
              className="mb-5"
            />
          ) : null}
          {showCriterionPicker ? (
            <CriterionPicker
              choices={choices}
              selectedCriterionId={selectedCriterionId}
              onSelect={selectCriterion}
            />
          ) : criteriaLoading && criterionSelectionRequiredForRoute ? (
            <PageLoading title="Loading project" />
          ) : (
            <Outlet />
          )}
        </div>
      </main>
    </div>
  );
}

// Bench replaces the paste-a-trace modal with the Examples hub: examples are
// added in bulk with expected labels there, and are never auto-judged.
function AddExamplesLauncher() {
  const navigate = useNavigate();
  return (
    <Button
      variant="default"
      size="sm"
      onClick={() => navigate("/datasets?add=1")}
      title="Paste example cases with expected labels — judged only when you run an eval"
    >
      <Plus /> Add examples
    </Button>
  );
}
