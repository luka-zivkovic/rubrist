import { useSearchParams } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Eyebrow, MarginNote } from "@/components/rubrist";
import { TraceDetail, type TraceDecisionKind } from "@/components/trace-detail";
import { fetchCaseDetail } from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { dashboardCriterionVersionId } from "@/lib/criterion-scope";
import { cn } from "@/lib/utils";
import type { ExceptionDetail } from "@rubrist/shared";

export interface ReviewPlayerItem {
  // Stable identity for the strip dots (queue item id, or the caseId itself
  // in ad-hoc mode).
  key: string;
  caseId: string;
  // Saved tasks may pin an exact recorded result; older tasks are explicitly unpinned.
  criterionVersionId?: string;
  skillVersionId?: string | undefined;
  judgeRunId?: string | undefined;
  queueItemId?: string | undefined;
  completed: boolean;
}

interface ReviewPlayerProps {
  eyebrow: string;
  name: string;
  // Short id shown next to the eyebrow (queue ids); omitted in ad-hoc mode.
  idTag?: string | undefined;
  // Ordered by the host: queue position, or the exception list order.
  items: ReviewPlayerItem[];
  marginNote?: { who: string; text: string } | undefined;
  onExit: () => void;
  // A decision landed on the case. Queue hosts reload their items (the server
  // marks completion); the ad-hoc host marks it client-side and tallies.
  onItemChanged: (caseId: string, kind: TraceDecisionKind) => void;
  // Rendered when every item is completed (unless the user reopened the walk).
  renderDone: (reopen: () => void) => React.ReactNode;
}

// The one sequential review surface. Both entry points — a persisted review
// queue and the ad-hoc "Review all N" flow from Exceptions/Overview — drive
// this player; verdicts always land through TraceDetail, exactly like the
// standalone case view, so there is no second review code path.
export function ReviewPlayer({
  eyebrow,
  name,
  idTag,
  items,
  marginNote,
  onExit,
  onItemChanged,
  renderDone
}: ReviewPlayerProps) {
  const { dashboard, refresh } = useDashboard();
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const [searchParams, setSearchParams] = useSearchParams();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [lastSaved, setLastSaved] = useState<{ key: string; position: number; kind: TraceDecisionKind } | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [changeKey, setChangeKey] = useState<string | null>(null);
  const completedCount = items.filter((i) => i.completed).length;
  const total = items.length;
  const allComplete = total > 0 && completedCount === total;

  // Land on the first pending item; if everything is done, on the last.
  const firstPendingIndex = items.findIndex((i) => !i.completed);
  const initialCursor = firstPendingIndex >= 0 ? firstPendingIndex : Math.max(0, total - 1);

  const requestedIndex = items.findIndex((item) => item.key === searchParams.get("at"));
  const [cursor, setCursor] = useState(requestedIndex >= 0 ? requestedIndex : initialCursor);
  const requestedKey = searchParams.get("at");
  useEffect(() => {
    if (requestedKey) {
      const index = items.findIndex((item) => item.key === requestedKey);
      if (index >= 0) setCursor(index);
    }
  }, [requestedKey]); // Items can refresh without resetting the reviewer's position.
  const pick = useCallback((index: number) => {
    const bounded = Math.max(0, Math.min(index, items.length - 1));
    setCursor(bounded);
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      if (items[bounded]) next.set("at", items[bounded].key);
      return next;
    }, { replace: true });
  }, [items, setSearchParams]);
  // `walkAgain` lets the user re-enter from the done view and stay in work
  // mode even when every item is already completed. Otherwise the allComplete
  // branch would short-circuit back on the next render.
  const [walkAgain, setWalkAgain] = useState(requestedIndex >= 0);

  // Clamp / re-anchor when the items list changes underneath us.
  useEffect(() => {
    if (total === 0) {
      setCursor(0);
      return;
    }
    setCursor((c) => Math.min(c, total - 1));
  }, [total]);

  // Advance to the next pending case (or just the next case if none are
  // pending) after the user records a decision on the current one.
  const current = items[cursor];
  const currentKeyRef = useRef(current?.key);
  currentKeyRef.current = current?.key;
  const criterionVersionId = current?.criterionVersionId ?? dashboardCriterionVersionId(dashboard);
  const [detail, setDetail] = useState<ExceptionDetail | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loadIdentity = `${current?.key}:${criterionVersionId}:${current?.skillVersionId}:${current?.judgeRunId}`;
  const [detailError, setDetailError] = useState<string | null>(null);
  // Bumping retryTick refetches the current case after a failed load.
  const [retryTick, setRetryTick] = useState(0);

  // Read exact saved evidence; criterion-only legacy tasks remain explicitly
  // unpinned. Cancel stale reads on task/scope changes, not host array churn.
  useEffect(() => {
    if (!current) return;
    setDetail(null);
    setDetailError(null);
    const targetCaseId = current.caseId;
    let cancelled = false;
    if (!criterionVersionId) return;
    fetchCaseDetail(targetCaseId, current.skillVersionId, criterionVersionId, current.judgeRunId)
      .then((d) => {
        if (!cancelled) { setDetail(d); setLoadedFor(loadIdentity); }
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [current?.key, current?.caseId, criterionVersionId, current?.skillVersionId, current?.judgeRunId, retryTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const prev = useCallback(() => pick(cursor - 1), [pick, cursor]);
  const next = useCallback(() => pick(cursor + 1), [pick, cursor]);

  const skip = useCallback(() => {
    if (!current) return;
    if (!current.completed) setSkipped((keys) => [...new Set([...keys, current.key])]);
    if (cursor === total - 1) setSummaryOpen(true);
    else next();
  }, [current, cursor, total, next]);

  const shortcuts = useMemo(
    () => ({ onSkip: skip, onPrev: prev, onNext: next, onExit }),
    [skip, next, prev, onExit]
  );

  const receipt = lastSaved ? (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-sm border border-rule-soft bg-paper-2 px-4 py-3 text-sm">
      <span>Case {lastSaved.position}: {lastSaved.kind === "promote" ? "golden-set entry saved" : "ruling recorded"}.</span>
      <Button variant="ghost" size="sm" onClick={() => {
        const index = items.findIndex((item) => item.key === lastSaved.key);
        if (index < 0) return;
        setSummaryOpen(false); setWalkAgain(true); setChangeKey(lastSaved.key);
        setRetryTick((value) => value + 1); pick(index);
      }}>Change ruling</Button>
    </div>
  ) : null;

  if ((allComplete && !walkAgain) || summaryOpen) {
    return (
      <>
        {receipt}
        {skipped.length > 0 ? <p className="mb-4 text-sm text-ink-2">{items.filter((item) => skipped.includes(item.key) && !item.completed).length} skipped this session; skipping does not record a ruling.</p> : null}
        {renderDone(() => {
          setSummaryOpen(false);
          pick(firstPendingIndex >= 0 ? firstPendingIndex : 0);
          setWalkAgain(true);
        })}
      </>
    );
  }

  return (
    <div className="fadeUp">
      <Topbar
        eyebrow={eyebrow}
        name={name}
        idTag={idTag}
        cursor={cursor}
        completedCount={completedCount}
        total={total}
        onExit={onExit}
      />

      {receipt}
      <NavStrip items={items} cursor={cursor} onPick={pick} onPrev={prev} onNext={next} onSkip={skip} />
      <div className="mb-4 flex justify-end"><Button variant="ghost" size="sm" onClick={() => setSummaryOpen(true)}>Session summary</Button></div>

      {!current ? (
        <Card>
          <CardContent className="py-8 text-center text-ink-3">Nothing to review.</CardContent>
        </Card>
      ) : detailError ? (
        <Card>
          <CardContent className="py-6 text-center">
            <div className="text-[13px] text-ink-2">{detailError}</div>
            <Button variant="default" size="sm" className="mt-3" onClick={() => setRetryTick((t) => t + 1)}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : !detail || loadedFor !== loadIdentity ? (
        <Card>
          <CardContent className="py-8 text-center text-ink-3">Loading trace…</CardContent>
        </Card>
      ) : (
        <>
          {marginNote ? (
            <MarginNote tone="neutral" who={marginNote.who} className="mb-5">
              Case {cursor + 1} of {total}. {marginNote.text}
            </MarginNote>
          ) : null}
          {current.queueItemId && !current.judgeRunId ? (
            <p className="mb-4 text-sm text-ink-2">This older task has no pinned evaluator result. It shows the latest recorded result for its criterion; your new ruling records exactly the result shown.</p>
          ) : null}
          <TraceDetail
            reviewQueueItemId={current.queueItemId}
            reviewTaskPending={Boolean(current.queueItemId && !current.completed)}
            headingAs="h2"
            key={`${current.key}:${detail.judgeRun.id}`}
            detail={detail}
            openRulingOnMount={changeKey === current.key}
            shortcuts={shortcuts}
            onChanged={(kind) => {
              if (!mountedRef.current) return;
              const caseId = current.caseId;
              void refresh();
              setLastSaved({ key: current.key, position: cursor + 1, kind });
              setChangeKey(null);
              setSkipped((keys) => keys.filter((key) => key !== current.key));
              if (currentKeyRef.current === current.key) {
                const remaining = items.map((item, index) => ({ item, index })).filter(({ item }) => item.key !== current.key && !item.completed);
                const nextItem = remaining.find(({ index }) => index > cursor) ?? remaining[0];
                if (nextItem) pick(nextItem.index);
                else if (kind !== "promote") setSummaryOpen(true);
              }
              onItemChanged(caseId, kind);
            }}
          />
        </>
      )}
    </div>
  );
}

function Topbar({
  eyebrow,
  name,
  idTag,
  cursor,
  completedCount,
  total,
  onExit
}: {
  eyebrow: string;
  name: string;
  idTag?: string | undefined;
  cursor: number;
  completedCount: number;
  total: number;
  onExit: () => void;
}) {
  const pct = total === 0 ? 0 : Math.round((completedCount / total) * 100);
  return (
    <div className="sticky top-0 z-10 -mx-5 -mt-7 mb-6 border-b border-rule-soft bg-paper/85 px-5 pt-3 pb-3 backdrop-blur sm:-mx-8 sm:px-8 xl:-mx-12 xl:-mt-9 xl:px-12">
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <Eyebrow>{eyebrow}</Eyebrow>
            {idTag ? <span className="min-w-0 break-all font-mono text-[10.5px] text-ink-3">· {idTag}</span> : null}
          </div>
          <h1 aria-label={`Case ${cursor + 1} of ${total} · ${name}`} className="mt-0.5 break-words font-serif sm:truncate text-[16px] font-medium tracking-[-0.012em]">
            {name}
          </h1>
          <div className="mt-1.5 flex items-center gap-3">
            <div className="h-[3px] flex-1 max-w-[420px] rounded-sm bg-paper-3">
              <div className="h-full rounded-sm bg-ink" style={{ width: `${pct}%` }} />
            </div>
            <div className="font-mono text-[11px] text-ink-3 whitespace-nowrap">
              <b className="font-medium text-ink">{completedCount}</b>
              <span className="text-ink-4"> of {total} done</span>
              <span className="text-ink-4"> · case {cursor + 1}</span>
            </div>
          </div>
        </div>
        <Button variant="default" size="sm" onClick={onExit}>
          <X /> Pause and exit
        </Button>
      </div>
    </div>
  );
}

function NavStrip({
  items,
  cursor,
  onPick,
  onPrev,
  onNext,
  onSkip
}: {
  items: ReviewPlayerItem[];
  cursor: number;
  onPick: (i: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-rule-soft pb-3">
      <Button variant="ghost" size="sm" disabled={cursor === 0} onClick={onPrev}>
        <ChevronLeft /> Prev
      </Button>
      <Button variant="default" size="sm" disabled={cursor >= items.length - 1} onClick={onNext}>
        Next <ArrowRight />
      </Button>
      <Button variant="ghost" size="sm" onClick={onSkip}>Skip for now</Button>
      <div className="ml-2 flex min-w-0 flex-1 flex-wrap items-center gap-[3px]">
        {items.map((item, i) => {
          const isCurrent = i === cursor;
          const cls = isCurrent ? "bg-ink" : item.completed ? "bg-ink-2" : "bg-rule-soft group-hover:bg-gold";
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onPick(i)}
              title={`Case ${i + 1} · ${item.caseId} · ${item.completed ? "completed" : "pending"}`}
              aria-label={`Go to case ${i + 1}`}
              className="group grid size-6 cursor-pointer place-items-center rounded-sm"
            >
              <span className={cn("size-1.5 rounded-sm", cls)} />
            </button>
          );
        })}
      </div>
      <div className="font-mono text-[10.5px] text-ink-3">
        {items[cursor]?.completed ? "recorded" : "not yet verdicted"}
      </div>
    </div>
  );
}
