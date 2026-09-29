import { PageLoading } from "../components/page-loading.js";
import { ApiUnavailableScreen } from "./system.js";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Eyebrow, KPI, KPIRow, MarginNote, SectionHead } from "@/components/rubrist";
import { ReviewPlayer } from "@/components/review-player";
import { useDashboard } from "@/lib/dashboard-context";
import { dashboardCriterionVersionId } from "@/lib/criterion-scope";
import { contextualHref } from "../lib/route-metadata.js";
import { queueReviewUrl, reviewCaseCriterionPin, selectReviewCaseIds } from "@/lib/exception-queue";
import type { TraceDecisionKind } from "@/components/trace-detail";
import type { SessionReceiptState } from "@/screens/exceptions";

function receiptFrom(decisions: Record<string, TraceDecisionKind>): SessionReceiptState {
  const counts = { accept: 0, override: 0, promote: 0 };
  for (const kind of Object.values(decisions)) counts[kind] += 1;
  return { decided: Object.keys(decisions).length, ...counts };
}

// Ad-hoc review: "Review all N" from Exceptions or the Overview opens the
// same sequential player a persisted review queue uses — no DB queue row is
// created. Links store all selected case IDs and recorded definition pins in
// the URL so refreshes preserve their scope. Older navigation can still supply router state or fall
// back to the current exception queue (optionally narrowed by the legacy
// ?cluster= query key, whose value is an exact judge category).
export function ReviewScreen() {
  const location = useLocation();
  const scope = new URLSearchParams(location.search);
  scope.delete("at");
  return <ReviewSession key={scope.toString()} />;
}

function ReviewSession() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { dashboard, loading, error, errorStatus, reload } = useDashboard();
  const categoryFilter = searchParams.get("cluster");
  const explicitCaseId = searchParams.get("caseId");

  const stateCaseIds = (location.state as { caseIds?: string[] } | null)?.caseIds;

  const caseIds: string[] = useMemo(() => {
    return selectReviewCaseIds({
      explicitCaseIds: searchParams.getAll("caseId"),
      explicitCaseId,
      stateCaseIds,
      exceptions: dashboard?.exceptions ?? [],
      categoryFilter
    });
  }, [searchParams, explicitCaseId, stateCaseIds, dashboard, categoryFilter]);

  // Client-side session state: which cases got a decision this walk, and what
  // kind — the done view tallies it. Nothing here persists; the verdicts
  // themselves landed on the cases through the player.
  const [decisions, setDecisions] = useState<Record<string, TraceDecisionKind>>({});

  const items = useMemo(
    () => caseIds.map((id) => {
      const criterionVersionId = reviewCaseCriterionPin(searchParams, id) || dashboard?.exceptions.find((exception) => exception.id === id)?.criterionVersionId || dashboardCriterionVersionId(dashboard) || undefined;
      return { key: id, caseId: id, ...(criterionVersionId ? { criterionVersionId } : {}), completed: Boolean(decisions[id]) };
    }),
    [caseIds, decisions, dashboard, searchParams]
  );

  // Freeze legacy/state-based selections before dashboard refreshes can remove
  // reviewed rows. The URL is the resumable source of case order and pins.
  useEffect(() => {
    if (searchParams.getAll("caseId").length || !items.length || items.some((item) => !item.criterionVersionId)) return;
    navigate(queueReviewUrl(items.map((item) => ({ id: item.caseId, criterionVersionId: item.criterionVersionId })), location.search, categoryFilter, searchParams.get("at") ?? undefined), { replace: true });
  }, [items, searchParams, navigate, location.search, categoryFilter]);

  if (loading && !dashboard && caseIds.length === 0) return <PageLoading title="Loading queue" shape="list" />;
  // Legacy links and router-state selections still need dashboard scope.
  // Fully pinned URLs can load their recorded evidence independently.
  if (error && !dashboard && (caseIds.length === 0 || items.some((item) => !item.criterionVersionId))) {
    return <ApiUnavailableScreen resource="the review queue" status={errorStatus} retry={() => void reload()} />;
  }

  if (caseIds.length === 0) {
    return (
      <div className="fadeUp">
        <SectionHead
          eyebrow="Review"
          title={categoryFilter ? `No exceptions in ${categoryFilter}` : "Queue is clear"}
          sub={error ?? "There are no cases in this selection."}
        />
        <div className="mt-4">
          <Button variant="default" asChild><Link to={contextualHref("/exceptions", location.search, ["cluster", "verdict"])}>
            <ArrowLeft /> Back to queue
          </Link></Button>
        </div>
      </div>
    );
  }

  // The receipt rides back to the queue as router state — the queue shows it
  // once; the durable record is the verdicts themselves.
  const exitToQueue = () => {
    const receipt = receiptFrom(decisions);
    navigate(contextualHref("/exceptions", location.search, ["cluster", "verdict"]), receipt.decided > 0 ? { state: { sessionReceipt: receipt } } : undefined);
  };

  return (
    <ReviewPlayer
      eyebrow="Review"
      name={categoryFilter ? `Review queue · ${categoryFilter.toLowerCase()}` : "Review queue waiting"}
      items={items}
      onExit={exitToQueue}
      onItemChanged={(caseId, kind) => setDecisions((prev) => ({ ...prev, [caseId]: kind }))}
      renderDone={(reopen) => (
        <DoneView
          decisions={decisions}
          total={caseIds.length}
          categoryFilter={categoryFilter}
          backHref={contextualHref("/", location.search)}
          queueHref={contextualHref("/exceptions", location.search, ["cluster", "verdict"])}
          canEdit={dashboard?.viewerRole === "owner"}
          skillHref={contextualHref(dashboard?.viewerRole === "owner" ? "/skill/edit" : "/skill", location.search)}
          onReopen={reopen}
        />
      )}
    />
  );
}

function DoneView({
  decisions,
  total,
  categoryFilter,
  backHref,
  queueHref,
  skillHref,
  canEdit,
  onReopen
}: {
  decisions: Record<string, TraceDecisionKind>;
  total: number;
  categoryFilter: string | null;
  backHref: string;
  queueHref: string;
  skillHref: string;
  canEdit: boolean;
  onReopen: () => void;
}) {
  const counts = Object.values(decisions).reduce(
    (acc, d) => {
      acc[d] += 1;
      return acc;
    },
    { accept: 0, override: 0, promote: 0 }
  );

  return (
    <div className="fadeUp max-w-[720px]">
      <Eyebrow>Review summary</Eyebrow>
      <h1 className="mt-2 font-serif text-[30px] font-medium leading-[1.08] tracking-[-0.02em]">
        {Object.keys(decisions).length} of {total} cases reviewed this session
        {categoryFilter ? ` in ${categoryFilter.toLowerCase()}` : ""}.
      </h1>
      <div className="mt-3 max-w-[60ch] text-[14px] leading-[1.55] text-ink-3">
        {total - Object.keys(decisions).length} cases were not reviewed in this session. Saved human labels remain on their cases.
        {counts.promote
          ? ` ${counts.promote} promoted ${counts.promote === 1 ? "case is" : "cases are"} now part of the golden set and will regression-test every future skill edit.`
          : ""}
      </div>

      <KPIRow className="mt-5 mb-5">
        <KPI label="Accepted" num={counts.accept} foot="skill verdicts confirmed" />
        <KPI
          label="Overridden"
          num={counts.override}
          delta={counts.override ? "reasons on file" : "—"}
          deltaKind={counts.override ? "signal" : "default"}
        />
        <KPI
          label="Promoted"
          num={counts.promote}
          delta={counts.promote ? "added to golden set" : "—"}
          deltaKind={counts.promote ? "up" : "default"}
        />
      </KPIRow>

      {counts.override >= 2 ? (
        <MarginNote tone="signal" who="Noticed during this session" className="mb-5 max-w-[620px]">
          You recorded {counts.override} overrides. If they point to the same evaluator gap, review
          the cases together before editing the guide.
          <div className="mt-2 flex gap-2">
            <Button variant="signal" size="sm" asChild><Link to={skillHref}>
              {canEdit ? "Draft rubric edit from these cases" : "View evaluator"}
            </Link></Button>
          </div>
        </MarginNote>
      ) : null}

      <Card className="mb-5">
        <CardContent className="flex flex-wrap gap-2 py-4">
          <Button variant="primary" asChild><Link to={queueHref} state={{ sessionReceipt: receiptFrom(decisions) }}>Back to queue</Link></Button>
          <Button variant="ghost" asChild><Link to={backHref}>Overview</Link></Button>
          <Button variant="ghost" onClick={onReopen}>
            Continue reviewing
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
