import { ReviewEvaluatorPicker, useReviewEvaluator } from "@/components/review-evaluator-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Plus, RefreshCcw } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RowLink } from "@/components/row-action";
import { Eyebrow, SectionHead } from "@/components/rubrist";
import { createReviewQueue, fetchReviewQueues, fetchReviewQueueSuggestion } from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { journeyStage } from "@/lib/journey";
import { dashboardCriterionVersionId } from "@/lib/criterion-scope";
import { cn } from "@/lib/utils";
import { useDialogFocus } from "@/hooks/use-dialog-focus";
import type { ReviewQueue, ReviewQueueSuggestion, Skill } from "@rubrist/shared";

export function ReviewQueuesScreen() {
  const navigate = useNavigate();
  const { dashboard } = useDashboard();
  const preProduction = dashboard ? journeyStage(dashboard) !== "production" : false;
  const criterionVersionId = dashboardCriterionVersionId(dashboard);
  const [queues, setQueues] = useState<ReviewQueue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setQueues(await fetchReviewQueues());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = queues.filter((q) => q.status === "open");
  const closed = queues.filter((q) => q.status === "closed");

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow={`Ungoverned legacy · Review queues · ${open.length} open`}
        title="Saved review queues"
        sub="Save ordinary cases in a named list and work through them with the legacy review flow. Reviewers can see existing evaluator evidence, so these queues do not create independent, blind, representative, or governed human truth."
        right={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCcw /> Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
              <Plus /> New queue
            </Button>
          </div>
        }
      />

      {error ? (
        <Card className="mb-5 border-signal-tint bg-signal-wash">
          <CardContent className="py-3 text-[12px] text-signal">{error}</CardContent>
        </Card>
      ) : null}

      <Card className="mb-6">
        <CardHeader>
          <div>
            <CardTitle>Open</CardTitle>
            <CardDescription>
              {open.length} {open.length === 1 ? "queue" : "queues"} in progress
            </CardDescription>
          </div>
        </CardHeader>
        {loading && queues.length === 0 ? (
          <CardContent className="py-8 text-center text-ink-3">Fetching queues…</CardContent>
        ) : open.length === 0 ? (
          <EmptyQueues
            kind="open"
            preProduction={preProduction}
            onNew={() => setShowNew(true)}
            onSetup={() => navigate("/")}
          />
        ) : (
          <ul className="divide-y divide-rule-soft">
            {open.map((q) => (
              <QueueRow key={q.id} queue={q} onOpen={() => navigate(`/review-queues/${q.id}`)} />
            ))}
          </ul>
        )}
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <div>
            <CardTitle>Closed</CardTitle>
            <CardDescription>{closed.length} archived · read-only</CardDescription>
          </div>
        </CardHeader>
        {closed.length === 0 ? (
          <EmptyQueues kind="closed" />
        ) : (
          <ul className="divide-y divide-rule-soft opacity-80">
            {closed.map((q) => (
              <QueueRow key={q.id} queue={q} onOpen={() => navigate(`/review-queues/${q.id}`)} />
            ))}
          </ul>
        )}
      </Card>

      <Card className="max-w-[82ch] border-dashed">
        <CardContent className="py-4">
          <Eyebrow>Evidence class · ungoverned_legacy</Eyebrow>
          <div className="mt-2 font-serif text-[14px] leading-[1.55] tracking-[-0.005em] text-ink-2">
            A queue is a saved list of ordinary cases from the same review flow as Review queue.
            Closing it does not remove any human labels; they remain attached to each case and searchable
            in Traces. Use Human Truth when you need fixed instructions, independent assignments,
            and governed review evidence.
          </div>
        </CardContent>
      </Card>

      {showNew ? (
        <NewQueueModal
          criterionVersionId={criterionVersionId}
          skill={dashboard?.skill ?? null}
          onCancel={() => setShowNew(false)}
          onCreated={(queue) => {
            setShowNew(false);
            void load();
            navigate(`/review-queues/${queue.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function QueueRow({ queue, onOpen }: { queue: ReviewQueue; onOpen: () => void }) {
  const total = queue.pendingCount + queue.completedCount;
  const pct = total === 0 ? 0 : Math.round((queue.completedCount / total) * 100);
  const isClosed = queue.status === "closed";

  return (
    <li
      onClick={onOpen}
      className="row-link grid cursor-pointer grid-cols-1 items-center gap-4 px-[18px] py-4 hover:bg-card-2 sm:grid-cols-2 xl:grid-cols-[1.4fr_1.2fr_160px_24px] xl:gap-5"
    >
      <div className="min-w-0">
        <RowLink
          to={`/review-queues/${queue.id}`}
          className="font-serif text-[15px] font-medium tracking-[-0.012em] text-ink"
        >
          {queue.name}
        </RowLink>
        {queue.description ? (
          <div className="mt-1 text-[12px] text-ink-3 line-clamp-2">{queue.description}</div>
        ) : null}
        <div className="mt-1 flex flex-wrap gap-2 font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
          <span>{total} cases</span>
          <span>·</span>
          <span>
            {isClosed ? (
              <>closed {queue.closedAt ? new Date(queue.closedAt).toLocaleDateString() : ""}</>
            ) : (
              <>{queue.pendingCount} pending</>
            )}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between font-mono text-[11px] text-ink-3">
          <span>
            {queue.completedCount} <span className="text-ink-4">of {total}</span>
          </span>
          <span className={cn(isClosed ? "text-ink-3" : "text-ink-2")}>{pct}%</span>
        </div>
        <div className="h-[3px] w-full rounded-sm bg-paper-3">
          <div
            className={cn("h-full rounded-sm", isClosed ? "bg-gold" : "bg-ink")}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
          {isClosed
            ? "queue closed"
            : queue.pendingCount === 0
              ? "ready to close"
              : `${queue.pendingCount} remaining`}
        </div>
      </div>

      <div>
        <Eyebrow>Created</Eyebrow>
        <div className="mt-1 font-mono text-[11px] text-ink-2">
          {new Date(queue.createdAt).toLocaleDateString()}
        </div>
        <div className="font-mono text-[10.5px] text-ink-3">
          {queue.createdByUserId ? "by a reviewer" : "automated"}
        </div>
      </div>

      <ChevronRight className="size-3 text-ink-3" />
    </li>
  );
}

function EmptyQueues({
  kind,
  preProduction,
  onNew,
  onSetup
}: {
  kind: "open" | "closed";
  preProduction?: boolean;
  onNew?: () => void;
  onSetup?: () => void;
}) {
  // Pre-production, queues are honestly "not a setup step" — point back at
  // the journey instead of nudging the user to curate an empty pile.
  if (kind === "open" && preProduction) {
    return (
      <CardContent className="py-10 text-center">
        <Eyebrow>Review queues · none yet</Eyebrow>
        <div className="mt-2 font-serif text-[15px] tracking-[-0.012em] text-ink-2">
          Queues come later.
        </div>
        <div className="mx-auto mt-1.5 max-w-[58ch] text-[12px] leading-[1.55] text-ink-3">
          A queue helps a reviewer work through a saved set of ordinary cases. Create one after
          traces or example results are available; it is not part of initial setup.
        </div>
        {onSetup ? (
          <Button variant="primary" size="sm" className="mt-4" onClick={onSetup}>
            Back to setup
          </Button>
        ) : null}
      </CardContent>
    );
  }
  return (
    <CardContent className="py-10 text-center">
      <Eyebrow>{kind === "open" ? "Nothing in flight" : "Nothing archived yet"}</Eyebrow>
      <div className="mt-2 font-serif text-[15px] tracking-[-0.012em] text-ink-2">
        {kind === "open"
          ? "No review queues are open. Create one when you want to save a set of cases for later review."
          : "Closed queues appear here with their recorded progress and case history."}
      </div>
      {kind === "open" && onNew ? (
        <Button variant="primary" size="sm" className="mt-4" onClick={onNew}>
          <Plus /> New queue
        </Button>
      ) : null}
    </CardContent>
  );
}

function NewQueueModal({
  skill,
  criterionVersionId,
  onCancel,
  onCreated
}: {
  skill: Skill | null;
  criterionVersionId: string | null;
  onCancel: () => void;
  onCreated: (queue: ReviewQueue) => void;
}) {
  const evaluator = useReviewEvaluator(skill);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ids, setIds] = useState("");
  const [suggestion, setSuggestion] = useState<ReviewQueueSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const requestGeneration = useRef(0);
  useEffect(() => {
    requestGeneration.current += 1;
    setSuggestion(null); setIds(""); setSuggesting(false);
    return () => { requestGeneration.current += 1; };
  }, [evaluator.selected?.id]);
  const suggest = async () => {
    if (!evaluator.selected) return;
    const generation = ++requestGeneration.current;
    const selectedId = evaluator.selected.id;
    setSuggesting(true); setError(null);
    try {
      const result = await fetchReviewQueueSuggestion(selectedId);
      if (generation !== requestGeneration.current) return;
      setSuggestion(result); setIds(result.items.map(item => item.caseId).join("\n"));
      setName(current => current || "Suggested review");
    } catch (err) {
      if (generation === requestGeneration.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === requestGeneration.current) setSuggesting(false);
    }
  };
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose: onCancel, closeOnEscape: !submitting });

  const parsedIds = ids
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const canSubmit = name.trim().length > 0 && parsedIds.length > 0 && Boolean(evaluator.selected) && !submitting && !suggesting;

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const trimmedDesc = description.trim();
      if (!evaluator.selected) throw new Error("Choose an evaluator version to review.");
      const selectedCriterion = evaluator.selected.criterionVersionId ?? criterionVersionId;
      const queue = await createReviewQueue({
        skillVersionId: evaluator.selected.id,
        name: name.trim(),
        ...(selectedCriterion ? { criterionVersionId: selectedCriterion } : {}),
        ...(trimmedDesc ? { description: trimmedDesc } : {}),
        caseIds: parsedIds,
        ...(suggestion ? { judgeRunIds: Object.fromEntries(suggestion.items.map(item => [item.caseId, item.judgeRunId])) } : {})
      });
      onCreated(queue);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-queue-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:items-center"
      onClick={(e) => {
        if (!submitting && e.target === e.currentTarget) onCancel();
      }}
    >
      <Card className="flex max-h-[calc(100dvh-2rem)] w-full max-w-full flex-col overflow-hidden shadow-elev sm:w-[600px]" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div>
            <CardTitle id="new-queue-title">New queue</CardTitle>
            <CardDescription>
              Suggest a small review batch, or add your own cases.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          <ReviewEvaluatorPicker selection={evaluator} disabled={submitting} previewPinned={Boolean(suggestion)} />
          <div className="rounded-sm border border-rule-soft bg-card-2 p-3">
            <Button variant="outline" size="sm" onClick={() => void suggest()} disabled={!evaluator.selected || submitting || suggesting}>
              {suggesting ? "Finding cases…" : "Suggest 10 cases"}
            </Button>
            <p className="mt-2 text-[12px] text-ink-2">Mix flagged and ambiguous results with passing spot checks. Skips results already reviewed or pending in an open queue. No extra model calls.</p>
            {suggestion ? <div className="mt-3">
              <p role="status" className="text-[12px] text-ink-2">{suggestion.items.length ? `${suggestion.items.length} cases suggested from ${suggestion.consideredCount} eligible results${suggestion.capped ? " (newest 1,000 only)" : ""}.` : "No eligible results for this evaluator version. Import and assess more cases, or finish an existing queue."} This is a review work list, not a representative sample.</p>
              <ul className="mt-2 max-h-60 overflow-y-auto divide-y divide-rule-soft" aria-label="Suggested cases">
                {suggestion.items.map(item => <li key={item.caseId} className="flex items-center justify-between gap-3 py-1.5 text-[12px]">
                  <span className="truncate font-mono" title={item.caseId}>{item.caseId}</span>
                  <span className={cn("shrink-0 rounded-sm border px-1.5 py-0.5 text-[11px]", item.reason === "flagged" ? "border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-300" : item.reason === "ambiguous" ? "border-amber-500/20 bg-amber-500/5 text-amber-800 dark:text-amber-300" : "border-emerald-500/20 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300")}>{item.reason === "flagged" ? "Evaluator flagged" : item.reason === "ambiguous" ? "Ambiguous result" : "Passing spot check"}</span>
                </li>)}
              </ul>
              <p className="mt-2 text-[12px] text-ink-3">Saving preserves these exact recorded results. Editing the case IDs switches to manual selection.</p>
            </div> : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-queue-name" className="eyebrow">Name</label>
            <input
              id="new-queue-name"
              autoFocus
              data-dialog-initial-focus
              value={name}
              disabled={submitting}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Refund eligibility · June calibration"
              className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-sans text-[13px] text-ink focus-visible:border-ink"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-queue-description" className="eyebrow">
              Description <span className="lowercase tracking-normal text-ink-3">(optional)</span>
            </label>
            <textarea
              id="new-queue-description"
              value={description}
              disabled={submitting}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What this queue is for. Shows on the row."
              className="resize-y rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-sans text-[12.5px] text-ink focus-visible:border-ink"
            />
          </div>

          <details open={!suggestion}>
            <summary className="cursor-pointer text-[12px] text-ink-2">Choose case IDs manually</summary>
            <div className="mt-2 flex flex-col gap-1.5">
            <label htmlFor="new-queue-case-ids" className="eyebrow">Case IDs</label>
            <textarea
              id="new-queue-case-ids"
              value={ids}
              disabled={submitting || suggesting}
              onChange={(e) => { setIds(e.target.value); setSuggestion(null); }}
              rows={5}
              placeholder={`Paste IDs — newline or comma separated\nex_8a31\nex_8a32, ex_8a30`}
              className="resize-y rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-mono text-[12px] text-ink focus-visible:border-ink"
            />
            <div className="font-mono text-[11px] text-ink-3">
              {parsedIds.length > 0
                ? `${parsedIds.length} id${parsedIds.length === 1 ? "" : "s"} detected`
                : "Paste IDs above — newline or comma separated. Up to 500 per queue."}
            </div>
          </div>

            </details>

          {error ? <div role="alert" className="text-[12px] text-signal">{error}</div> : null}

        </CardContent>
        <CardFooter className="shrink-0">
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <div className="flex-1" />
            <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
              Create queue
            </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
