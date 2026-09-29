import { InlineDetails } from "../components/rubrist/inline-details.js";
import { overviewNextAction } from "../lib/overview-next-action.js";
import { queueReviewUrl } from "../lib/exception-queue.js";
import { contextualHref } from "../lib/route-metadata.js";
import { PageLoading } from "../components/page-loading.js";
import { ApiUnavailableScreen } from "./system.js";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Table } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { Eyebrow, SectionHead, KPI, KPIRow, DistBar, Legend, VerdictChip, Chip, JourneyPipeline, Receipt, Ref } from "@/components/rubrist";
import { DashboardWelcome } from "@/screens/dashboard-welcome";
import { DashboardBenchWelcome } from "@/screens/dashboard-bench-welcome";
import { DashboardProvisional } from "@/screens/dashboard-provisional";
import { FirstRunSetupLedger } from "@/components/first-run-setup-ledger";
import { FirstProjectKeyCard } from "@/components/first-project-key";
import { FirstVerdictCard } from "@/components/first-verdict";
import { RowLink } from "@/components/row-action";
import { countLegacyHumanCheckedCases } from "@/lib/legacy-human-checks";
import { useDashboard } from "@/lib/dashboard-context";
import { isBench, journeyStage, takeSetupReceipt, clearSetupReceipt } from "@/lib/journey";
import { skillVersionStateLabel } from "../lib/skill-presentation.js";
import type { CapabilityGap } from "@rubrist/shared";
import { describeExecutionBinding } from "@rubrist/shared";

const QUEUE_VOLUME: Record<CapabilityGap["severity"], string> = {
  high:   "High unresolved volume",
  medium: "Moderate unresolved volume",
  low:    "Low unresolved volume"
};

export function DashboardScreen() {
  const location = useLocation();
  const navigate = useNavigate();
  const { dashboard, loading, error, errorStatus, reload } = useDashboard();
  const [receipt, setReceipt] = useState<string | null>(() => takeSetupReceipt());
  const criterionId = dashboard?.skill.criterionId ?? null;

  // "Says who, about which cases?" — the legacy human-check number is counted
  // from the verdict log itself (distinct cases with a human or adjudicated
  // verdict). Governed truth lives on a separate evidence path.
  const [legacyHumanChecked, setLegacyHumanChecked] = useState<number | null>(null);
  useEffect(() => {
    if (!criterionId) {
      setLegacyHumanChecked(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const checkedCases = await countLegacyHumanCheckedCases(criterionId);
        if (!cancelled) {
          setLegacyHumanChecked(checkedCases);
        }
      } catch {
        if (!cancelled) setLegacyHumanChecked(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [criterionId]);

  const totals = useMemo(() => {
    if (!dashboard) return null;
    const { pass, fail, ambiguous } = dashboard.verdictDistribution;
    const total = pass + fail + ambiguous;
    return {
      total,
      pass,
      fail,
      ambiguous,
      passPct: total ? Math.round((pass / total) * 100) : 0,
      failPct: total ? Math.round((fail / total) * 100) : 0,
      ambigPct: total ? Math.round((ambiguous / total) * 100) : 0
    };
  }, [dashboard]);

  if (loading && !dashboard) return <PageLoading title="Loading project overview" shape="detail" />;

  if (error || !dashboard || !totals) {
    return <ApiUnavailableScreen resource="the project overview" status={errorStatus} retry={() => void reload()} />;
  }

  const setupReceipt = receipt ? (
    <Receipt
      className="mb-5"
      meta="this session"
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            clearSetupReceipt();
            setReceipt(null);
          }}
        >
          <X /> Dismiss
        </Button>
      }
    >
      <b>Setup update.</b> {receipt}
    </Receipt>
  ) : null;

  // Journey stages (P0-1), derived from real state:
  //   day0        → setup ledger (nothing imported, nothing to show)
  //   provisional → traces in, starter rubric never approved — verdicts wear
  //                 the dashed badge until review or explicit sign-off
  //   production  → the dashboard below
  const stage = journeyStage(dashboard);
  if (stage === "day0") {
    // Owners only: creating a pairing is owner-gated server-side, so showing
    // the card to members would offer a guaranteed-403 action.
    const canPairAgent = dashboard.viewerRole === "owner" && dashboard.skill.isStarter;
    return (
      <div className="max-w-[1760px]">
        {setupReceipt}
        {isBench(dashboard.project)
          ? <DashboardBenchWelcome dashboard={dashboard} canPairAgent={canPairAgent} />
          : <DashboardWelcome dashboard={dashboard} canPairAgent={canPairAgent} />}
      </div>
    );
  }
  if (stage === "provisional") {
    return (
      <div className="max-w-[1760px]">
        {setupReceipt}
        <DashboardProvisional
          dashboard={dashboard}
          onSignedOff={() => {
            setReceipt(takeSetupReceipt());
            void reload();
          }}
        />
      </div>
    );
  }

  const { project, skill, exceptions, topCapabilityGaps, goldenSetSize } = dashboard;
  // Bench copy rule: supplied examples, never traces; no sync-back or
  // trace-screen targets (both are outside the bench IA); "established",
  // never production language.
  const bench = isBench(project);
  const importedTotal = project.importedTraceCount;
  const exceptionsTotal = dashboard.exceptionsTotal ?? null;
  const syncBackPct = Math.round(project.syncBackCoverage * 100);
  const agreement = skill.currentVersion.goldenSetAgreement;
  const agreementPct = agreement == null ? null : Math.round(agreement * 100);
  const nextAction = overviewNextAction(dashboard, location.search);
  const versionStateLabel = skill.isStarter
    ? `v${skill.currentVersion.version} · Starter · unvalidated`
    : skillVersionStateLabel(skill.currentVersion);

  return (
    <div className="fadeUp max-w-[1760px]">
      <FirstProjectKeyCard project={project} className="mb-5" />
      {setupReceipt}
      <SectionHead
        eyebrow="Overview"
        title="Overview"
        sub={bench
          ? "See what is ready, what still needs an example or case, and the next action for this evaluator."
          : "See what is set up, what needs a human, and the next action for this criterion before opening detailed evidence."}
        when={`Data as of ${new Date(project.updatedAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        })}`}
      />

      <Card className="mb-5 border-rule" aria-label="Next action">
        <CardContent className="flex flex-wrap items-center gap-4 py-5">
          <div className="min-w-0 flex-1 basis-[280px]">
            <Eyebrow>Next</Eyebrow>
            <h2 className="mt-1 font-serif text-xl font-medium">{nextAction.title}</h2>
            <p className="mt-2 max-w-[72ch] text-sm leading-relaxed text-ink-3">{nextAction.description}</p>
          </div>
          <Button variant="primary" className="h-auto min-h-11 max-w-full whitespace-normal" asChild><Link to={nextAction.href}>{nextAction.label} <ArrowRight /></Link></Button>
        </CardContent>
      </Card>

{exceptions.length > 0 ? (
      <Card className="mb-7">
        <CardHeader>
          <div>
            <CardTitle>Review queue waiting</CardTitle>
            <CardDescription>Showing {Math.min(exceptions.length, 5)} of {exceptionsTotal ?? "an unknown number of"} waiting cases. The review queue loads up to 50 at a time.</CardDescription>
          </div>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" asChild><Link to={contextualHref("/exceptions", location.search)}>
            Open queue <ArrowRight />
          </Link></Button>
        </CardHeader>
        <Table className="ledger-stacked" role="table" aria-label="Waiting case preview">
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader" style={{ width: 130 }}>When</th>
              <th scope="col" role="columnheader">Case</th>
              <th scope="col" role="columnheader" style={{ width: 150 }}>Assessment</th>
              <th scope="col" role="columnheader">Reason</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {exceptions.slice(0, 5).map((ex) => (
              <tr role="row"
                key={ex.id}
                className="row-link row-signal"
                onClick={() => navigate(`${queueReviewUrl(exceptions, location.search)}&at=${encodeURIComponent(ex.id)}`)}
              >
                <td role="cell" data-label="When" className="font-mono text-ink-3">
                  {new Date(ex.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </td>
                <td role="cell" data-label="Case">
                  <RowLink
                    to={`${queueReviewUrl(exceptions, location.search)}&at=${encodeURIComponent(ex.id)}`}
                  >
                    {ex.title}
                  </RowLink>
                  <div className="mt-1 flex items-center gap-2">
                    {ex.capabilityGap ? (
                      <Ref
                        kind="category"
                        label={ex.capabilityGap}
                        onClick={() => navigate(contextualHref(`/exceptions?cluster=${encodeURIComponent(ex.capabilityGap as string)}`, location.search))}
                      />
                    ) : null}
                    <InlineDetails label="Trace ID">{ex.traceId}</InlineDetails>
                  </div>
                </td>
                <td role="cell" data-label="Assessment">
                  <VerdictChip verdict={ex.verdict} />
                </td>
                <td role="cell" data-label="Reason" className="text-ink-3"><span className="line-clamp-2">{ex.reason || "No explanation recorded."}</span></td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      ) : null}
      <details className="mb-7 rounded-sm border border-rule-soft px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">Setup progress and first assessment</summary>
        <div className="mt-4">
      {bench ? (
        <FirstRunSetupLedger dashboard={dashboard} className="mb-7" />
      ) : (
        <JourneyPipeline dashboard={dashboard} onNavigate={navigate} />
      )}

      {dashboard.currentVersionResultCount === 1 ? (
        <FirstVerdictCard
          dashboard={dashboard}
          onOpenCase={(caseId) => navigate(contextualHref(`/cases/${caseId}?skillVersionId=${encodeURIComponent(skill.currentVersion.id)}`, location.search), { state: { backTo: "/", backLabel: "Back to overview" } })}
          className="mb-7"
        />
      ) : null}

        </div>
      </details>

      <KPIRow className="mb-7">
        <KPI
          label={bench ? "Examples" : "Traces imported"}
          num={importedTotal.toLocaleString()}
          delta={bench ? "supplied · no production traces" : project.traceProvider === "manual" ? "manual import" : `${project.traceProvider} · live`}
          deltaKind="up"
          foot={`as of ${new Date(project.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
          to={bench ? "/datasets" : "/traces"}
          src={bench ? "open examples →" : "open traces →"}
        />
        <KPI
          label="Legacy human checks"
          num={legacyHumanChecked === null ? "—" : legacyHumanChecked.toLocaleString()}
          delta={bench ? "ungoverned case reviews" : "ungoverned queues + adjudications"}
          foot="not governed human truth"
        />
        {bench ? (
          <KPI
            label="Golden set"
            num={goldenSetSize}
            delta={goldenSetSize === 0 ? "gate advisory only" : "gate armed"}
            deltaKind={goldenSetSize === 0 ? "signal" : "default"}
            foot="known cases used to catch evaluator regressions"
            to="/golden"
            src="open golden set →"
          />
        ) : project.traceProvider === "manual" ? (
          <KPI
            label="Sync-back"
            num="—"
            delta="no tracer connected"
            foot="connect one to write verdicts back"
            to="/integrations"
            src="open integrations →"
          />
        ) : (
          <KPI
            label="Sync-back"
            num={syncBackPct}
            unit="%"
            delta={syncBackPct === 100 ? "clean" : "partial"}
            deltaKind={syncBackPct === 100 ? "up" : "signal"}
            foot="Verdicts written back to trace platform"
            to="/integrations"
            src="open integrations →"
          />
        )}
      </KPIRow>

      <Card className="mb-7">
        <CardHeader>
          <div>
          <CardTitle>Assessment distribution</CardTitle>
            <CardDescription>
              The latest evaluator result for each recorded case. Earlier results and repeated
              runs are excluded.
            </CardDescription>
          </div>
          <div className="flex-1" />
          <Legend
            items={[
              { color: "var(--ink)", label: `Pass · ${totals.pass}` },
              { color: "var(--signal)", label: `Fail · ${totals.fail}` },
              { color: "var(--ambig-pattern)", label: `Ambiguous · ${totals.ambiguous}` }
            ]}
          />
        </CardHeader>
        <CardContent>
          <DistBar pass={totals.pass} fail={totals.fail} ambig={totals.ambiguous} />
          <div className="mt-3 font-mono text-[11px] text-ink-3">
            {totals.passPct}% pass · {totals.failPct}% fail · {totals.ambigPct}% ambiguous
          </div>
        </CardContent>
      </Card>

      <div className="mb-7 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Evaluator categories</CardTitle>
              <CardDescription>
                Exact failure categories supplied by the evaluator, counted within the loaded cases. They filter those cases; they do not imply similarity.
              </CardDescription>
            </div>
            <div className="flex-1" />
            <div className="font-mono text-[11px] text-ink-3">loaded queue</div>
          </CardHeader>
          <Table>
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ width: 80 }}>Cases</th>
                <th>Loaded queue volume</th>
              </tr>
            </thead>
            <tbody>
              {topCapabilityGaps.length === 0 ? (
                <tr>
                  <td colSpan={3} className="text-center text-ink-3">
                    No judge categories yet. Categories appear when evaluator outputs include a
                    failure category; Rubrist does not group cases by semantic similarity.
                  </td>
                </tr>
              ) : null}
              {topCapabilityGaps.map((gap) => (
                <tr
                  key={gap.id}
                  className="row-link"
                  onClick={() => navigate(contextualHref(`/exceptions?cluster=${encodeURIComponent(gap.name)}`, location.search))}
                >
                  <td>
                    <RowLink to={contextualHref(`/exceptions?cluster=${encodeURIComponent(gap.name)}`, location.search)}>
                      {gap.name}
                    </RowLink>
                  </td>
                  <td className="font-mono">{gap.count}</td>
                  <td className="text-ink-3">{QUEUE_VOLUME[gap.severity]}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>{bench ? "Evaluator on the bench" : "Evaluator in production"}</CardTitle>
              <CardDescription>
                {bench ? "The artifact judging your examples." : "The artifact judging your traces."}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Eyebrow>name</Eyebrow>
                <div className="mt-0.5 font-serif text-[17px] font-medium tracking-[-0.015em]">{skill.name}</div>
              </div>
              {/* The VERSION's status, not the parent skill's — skills.status
                  stays "draft" forever while versions move through the gate,
                  which read as "production skill: draft" next to an approved
                  version. */}
              <Chip>{versionStateLabel}</Chip>
            </div>
            <Separator />
            <div className="flex items-end justify-between">
              <div>
                <Eyebrow>Golden-set agreement</Eyebrow>
                <div className="mt-1 flex items-baseline gap-2">
                  <div className="font-serif text-[24px] font-medium tracking-[-0.025em]">
                    {agreementPct == null ? "—" : `${agreementPct}%`}
                  </div>
                  <div className="font-mono text-[12px] text-ink-3">{goldenSetSize} golden cases</div>
                </div>
              </div>
              <details className="text-[12px] text-ink-3">
                <summary className="cursor-pointer">Too strict / lenient</summary>
                <div className="mt-1 font-mono text-[12px] text-dev">
                  {skill.currentVersion.tooStrictCount} / {skill.currentVersion.tooLenientCount}
                </div>
              </details>
            </div>
            <Separator />
            <div className="flex flex-col gap-1.5 font-mono text-[11px] text-ink-3">
              <div>
                Model · <span className="text-ink">{skill.currentVersion.executionBinding.provider}/{skill.currentVersion.executionBinding.modelId}</span>
              </div>
              <div>
                Binding · <span className="text-ink">{describeExecutionBinding(skill.currentVersion.executionBinding)}</span>
              </div>
              <div>
                Owner · <span className="text-ink">{skill.ownerName}</span>
              </div>
            </div>
            <Button variant="default" className="mt-2 self-start" onClick={() => navigate(contextualHref("/skill", location.search))}>
              Open evaluator <ArrowRight />
            </Button>
          </CardContent>
        </Card>
      </div>



    </div>
  );
}
