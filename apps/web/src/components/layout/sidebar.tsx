import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Flag,
  FileCog,
  Star,
  Database,
  Plug,
  ListChecks,
  Inbox,
  Scale,
  Settings as SettingsIcon,
  Check,
  ChevronDown,
  Plus,
  Layers3,
  ShieldCheck,
  Microscope,
  Activity
} from "lucide-react";
import { useTheme } from "next-themes";
import { NewProjectModal } from "@/components/project-create";
import { RubristBrand } from "@/components/rubrist-brand";
import { fetchProjects, selectProject, selectedProjectId } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { useAppMode } from "@/lib/app-mode";
import { routeMetadata } from "../../lib/route-metadata.js";
import { useCriterion } from "@/lib/criterion-context";
import { cn } from "@/lib/utils";
import type { Project } from "@rubrist/shared";

interface WorkspaceNavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  withBadge?: boolean;
}

interface WorkspaceNavGroup {
  label: string;
  items: WorkspaceNavItem[];
}

// One inventory for both evidence sources. These groups describe destinations,
// not evidence validity or completion of the evaluator lifecycle.
function workspaceNavigation(bench: boolean): WorkspaceNavGroup[] {
  return [
    { label: "Start", items: [{ to: "/", label: "Overview", icon: LayoutDashboard }] },
    { label: "Evidence & review", items: [
      ...(!bench ? [{ to: "/traces", label: "Live traces", icon: ListChecks }] : []),
      { to: "/datasets", label: bench ? "Examples & runs" : "Saved datasets", icon: Database },
      { to: "/exceptions", label: "Needs a human · ungoverned", icon: Flag, withBadge: true },
      { to: "/review-queues", label: "Review sessions · ungoverned", icon: Inbox }
    ] },
    { label: "Evaluator work", items: [
      { to: "/criteria", label: "Criteria", icon: Layers3 },
      { to: "/skill", label: "Review guide", icon: FileCog },
      { to: "/golden", label: "Golden set", icon: Star }
    ] },
    { label: "Governed lifecycle", items: [
      { to: "/analyze", label: "Analyze · find failures", icon: Microscope },
      { to: "/human-truth", label: "Human truth · governed", icon: ShieldCheck }
    ] },
    { label: "Ungoverned diagnostics", items: [
      { to: "/reliability", label: "Reliability signals", icon: Scale },
      { to: "/production-calibration", label: "Production calibration", icon: Activity }
    ] },
    { label: "Setup", items: [
      { to: "/integrations", label: "Integrations", icon: Plug },
      { to: "/settings", label: "Settings", icon: SettingsIcon }
    ] }
  ];
}

export interface SidebarProps {
  projectName?: string;
  projectSource?: string;
  exceptionsCount?: number;
  bench?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function Sidebar({
  projectName = "Rubrist",
  projectSource = "—",
  exceptionsCount = 0,
  bench = false,
  mobileOpen = false,
  onMobileClose
}: SidebarProps) {
  const location = useLocation();
  const { href: criterionHref } = useCriterion();
  const navGroups = workspaceNavigation(bench);
  const routeActivePath = routeMetadata(location.pathname, location.search, bench).activePath;
  const activePath = routeActivePath === "/traces" && bench ? "/datasets" : routeActivePath;
  const { theme, setTheme } = useTheme();
  const session = useSession();
  const userName = session.data?.user?.name ?? "Operator";
  const initial = (userName[0] ?? "C").toUpperCase();
  const role = session.data?.user?.email ?? "Skill owner";

  return (
    <aside
      id="workspace-navigation"
      aria-label="Workspace sidebar"
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex w-[min(85vw,256px)] h-dvh flex-col overflow-y-auto border-r border-rule bg-paper-2 pt-[18px] pb-3.5 shadow-[var(--shadow-elev)] transition-transform duration-200 lg:sticky lg:top-0 lg:z-auto lg:h-screen lg:w-auto lg:translate-x-0 lg:visible lg:shadow-none",
        mobileOpen
          ? "visible translate-x-0"
          : "invisible -translate-x-full [transition:transform_200ms,visibility_0s_200ms]"
      )}
      tabIndex={-1}
    >
      <div className="flex items-center gap-2.5 border-b border-rule-soft px-[22px] pt-1 pb-[18px] mb-3.5">
        <RubristBrand
          markClassName="size-5"
          nameClassName="font-serif text-[17px] font-semibold tracking-[-0.025em] text-ink"
        />
        <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">v0.4 · Audit</div>
      </div>

      <ProjectSwitcher projectName={projectName} projectSource={projectSource} />

      <nav aria-label="Project navigation">
        {navGroups.map((group) => (
          <NavSection
            key={group.label}
            label={group.label}
          >
            {group.items.map((item) => {
              const showBadge = item.withBadge && exceptionsCount > 0;
              return (
                <NavItem
                  key={item.to}
                  to={criterionHref(item.to)}
                  activePath={activePath}
                  icon={<item.icon className="h-3.5 w-3.5" />}
                  label={item.label}
                  {...(showBadge ? { badge: exceptionsCount, badgeSignal: true } : {})}
                  onNavigate={onMobileClose}
                />
              );
            })}
          </NavSection>
        ))}
      </nav>

      <div className="mt-auto border-t border-rule-soft px-3.5 pt-3">
        <div className="mt-3 flex items-center gap-2.5 text-[12px] text-ink-2">
          <div className="grid h-[22px] w-[22px] place-items-center rounded-full bg-ink text-[11px] font-medium text-paper">
            {initial}
          </div>
          <div className="flex min-w-0 flex-col">
            <div className="truncate">{userName}</div>
            <div className="font-mono text-[10px] text-ink-4 truncate">{role}</div>
          </div>
          <button
            type="button"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="ml-auto cursor-pointer border border-rule-soft bg-transparent px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3 hover:bg-paper-3"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </div>
    </aside>
  );
}

// P0-2: a switcher that actually switches. Projects load when the popover
// opens; picking one pins it (x-rubrist-project on every call) and reloads so
// every cached surface re-resolves. In demo mode the popover still lists the
// single seeded project — the affordance is real either way.
function ProjectSwitcher({ projectName, projectSource }: { projectName: string; projectSource: string }) {
  const { demoMode } = useAppMode();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const current = selectedProjectId();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchProjects()
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function pick(project: Project) {
    selectProject(project.id);
    window.location.assign("/");
  }

  return (
    <div ref={wrapRef} className="relative mx-3.5 mb-[18px]">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Switch project — ${projectName}`}
        aria-expanded={open}
        aria-controls={popoverId}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-sm border border-rule bg-card px-3 py-2.5 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="h-2 w-2 shrink-0 rounded-full bg-ink" />
        <div className="flex min-w-0 flex-col">
          <div className="text-[12.5px] font-medium truncate">{projectName}</div>
          <div className="font-mono text-[10px] text-ink-4 truncate">{projectSource}</div>
        </div>
        <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-ink-4" />
      </button>

      {open ? (
        <div id={popoverId} className="fadeUp absolute left-0 top-full z-40 mt-1 w-[280px] rounded-sm border border-rule bg-card py-1.5 shadow-[var(--shadow-elev)]">
          {projects === null && !loadError ? (
            <div className="px-3.5 py-2.5 text-[12px] text-ink-3">Loading projects…</div>
          ) : loadError ? (
            <div role="alert" className="px-3.5 py-2.5 text-[12px] text-signal">{loadError}</div>
          ) : (
            (projects ?? []).map((p) => {
              const active = current ? p.id === current : p.name === projectName;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left hover:bg-card-2",
                    active && "bg-card-2"
                  )}
                  aria-current={active ? "true" : undefined}
                  onClick={() => pick(p)}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full bg-ink" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12.5px] font-medium">{p.name}</span>
                    <span className="truncate font-mono text-[10px] text-ink-4">
                      {p.mode === "bench"
                        ? `Judge a dataset · ${p.importedTraceCount.toLocaleString()} examples`
                        : `Judge live traces · ${p.importedTraceCount.toLocaleString()} traces`}
                    </span>
                  </span>
                  {active ? <Check className="h-3 w-3 shrink-0" /> : null}
                </button>
              );
            })
          )}
          <div className="my-1.5 border-t border-rule-soft" />
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left hover:bg-card-2"
            onClick={() => {
              setOpen(false);
              setShowNew(true);
            }}
          >
            <Plus className="h-3 w-3" />
            <span className="text-[12.5px]">New project</span>
            <span className="ml-auto font-mono text-[10px] text-ink-4">
              {demoMode ? "auth mode only" : ""}
            </span>
          </button>
        </div>
      ) : null}

      {showNew ? (
        <NewProjectModal
          onClose={() => {
            setShowNew(false);
            window.requestAnimationFrame(() => triggerRef.current?.focus());
          }}
        />
      ) : null}
    </div>
  );
}

function NavSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2.5 px-3.5">
      <div className="flex items-center px-2 pb-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-4">
        <span>{label}</span>
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

interface NavItemProps {
  activePath: string;
  to: string;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  badgeSignal?: boolean;
  onNavigate?: (() => void) | undefined;
}

function NavItem({ to, icon, label, badge, badgeSignal, onNavigate, activePath }: NavItemProps) {
  const isActive = activePath === to.split("?")[0];
  return (
    <Link to={to} aria-current={isActive ? "page" : undefined} className="block" onClick={onNavigate}>
        <div
          className={cn(
            "relative flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-[7px] text-[13px] text-ink-2 select-none",
            isActive ? "bg-card text-ink" : "hover:bg-paper-3"
          )}
        >
          {isActive ? (
            <span className="absolute -left-3.5 top-1.5 bottom-1.5 w-[2px] bg-ink" />
          ) : null}
          <span className={cn(isActive ? "text-ink" : "text-ink-3")}>{icon}</span>
          <span>{label}</span>
          {badge != null && badge > 0 ? (
            <span
              className={cn(
                "ml-auto font-mono text-[10px]",
                badgeSignal ? "text-signal" : isActive ? "text-ink-2" : "text-ink-4"
              )}
            >
              {badge}
            </span>
          ) : null}
        </div>
    </Link>
  );
}
