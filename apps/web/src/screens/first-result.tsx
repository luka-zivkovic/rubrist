import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, CircleAlert, LoaderCircle, RefreshCcw } from "lucide-react";
import { payloadRationale, verdictLabelFromPayload, type CriterionVersion, type EvalRunDetail, type VerdictRecord } from "@rubrist/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eyebrow, SectionHead, VerdictChip } from "@/components/rubrist";
import {
  ensureSkillVersionBackfill,
  fetchCaseVerdicts,
  fetchEvalRunDetail,
  fetchEvalRuns,
  fetchProjectVerdicts,
  fetchSkillVersionCriterion
} from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { firstAssessmentRunForVersion, verdictForTrackedItem } from "@/lib/first-result";
import { firstResultPath, markSetupReceipt } from "@/lib/journey";

const POLL_MS = 2000;

export function FirstResultScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const versionId = searchParams.get("version");
  const skillId = searchParams.get("skill");
  const criterionId = searchParams.get("criterionId");
  const { dashboard, refresh } = useDashboard();
  const [run, setRun] = useState<EvalRunDetail | null>(null);
  const [result, setResult] = useState<{ caseId: string; verdict: VerdictRecord } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dispatchPending, setDispatchPending] = useState(false);
  const [canStartExisting, setCanStartExisting] = useState(false);
  const [criterionVersion, setCriterionVersion] = useState<CriterionVersion | null>(null);
  const [criterionError, setCriterionError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const receiptKey = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  const nextEnsureAt = useRef(0);

  useEffect(() => {
    if (!skillId || !versionId || !criterionId) return;
    let cancelled = false;
    setCriterionVersion(null);
    setCriterionError(null);
    void fetchSkillVersionCriterion(skillId, versionId)
      .then((criterion) => {
        if (cancelled) return;
        if (criterion.criterionId !== criterionId) {
          setCriterionError("This first-assessment link does not match the evaluator's quality question.");
          return;
        }
        setCriterionVersion(criterion);
      })
      .catch((cause) => {
        if (!cancelled) setCriterionError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [criterionId, skillId, versionId]);

  const load = useCallback(async (generation: number) => {
    const current = () => generation === loadGeneration.current;
    if (!versionId || !skillId || !criterionId) {
      if (current()) {
        setError("This first-assessment link is missing its evaluator identity.");
        setLoading(false);
      }
      return false;
    }
    try {
      const [runs, recordedVerdicts] = await Promise.all([
        fetchEvalRuns(100, versionId, "first_assessment"),
        fetchProjectVerdicts({
          source: "llm_judge",
          skillVersionId: versionId,
          evidenceScope: "customer",
          limit: 1
        })
      ]);
      if (!current()) return false;
      const summary = firstAssessmentRunForVersion(runs, versionId, recordedVerdicts);
      let detail: EvalRunDetail | null;
      let observedDispatchPending: boolean | undefined;
      let nextEnsureDelayMs: number | null = null;
      if (summary) {
        const canEnsure = dashboard?.viewerRole === "owner"
          && (summary.status === "pending" || summary.status === "running")
          && Date.now() >= nextEnsureAt.current;
        if (canEnsure) {
          const ensured = await ensureSkillVersionBackfill(skillId, versionId);
          nextEnsureDelayMs = ensured.retryAfterMs;
          observedDispatchPending = ensured.dispatchPending;
          detail = ensured.run;
        } else {
          detail = await fetchEvalRunDetail(summary.id);
          if (detail && detail.status !== "pending") observedDispatchPending = false;
        }
      } else if (recordedVerdicts[0]) {
        const verdict = recordedVerdicts[0];
        setRun(null);
        setResult({ caseId: verdict.caseId, verdict });
        setDispatchPending(false);
        setError(null);
        setLoading(false);
        if (receiptKey.current !== verdict.id) {
          receiptKey.current = verdict.id;
          const receiptVersion = dashboard?.skill.currentVersion.id === versionId
            ? dashboard.skill.currentVersion.version
            : versionId;
          markSetupReceipt(`Evaluator v${receiptVersion} returned an assessment on recorded evidence.`);
          void refresh();
        }
        return false;
      } else if (!dashboard) {
        return true;
      } else if (dashboard.project.importedTraceCount === 0) {
        setError("Add a recorded case before asking for the first assessment.");
        setLoading(false);
        return false;
      } else if (dashboard.viewerRole !== "owner") {
        setError("An owner needs to start this first assessment. You can still inspect the recorded cases.");
        setLoading(false);
        return false;
      } else {
        // The trace may be saved before its import run is scheduled. Absence
        // of a run is never permission to evaluate all historical cases.
        setCanStartExisting(true);
        setError("No saved evaluation run yet. Import a case with this evaluator, or explicitly evaluate existing cases.");
        setLoading(false);
        return true;
      }
      setCanStartExisting(false);
      if (!current()) return false;
      if (nextEnsureDelayMs !== null) nextEnsureAt.current = Date.now() + nextEnsureDelayMs;
      if (observedDispatchPending !== undefined) setDispatchPending(observedDispatchPending);
      if (!detail) {
        const [recorded] = await fetchProjectVerdicts({
          source: "llm_judge",
          skillVersionId: versionId,
          evidenceScope: "customer",
          limit: 1
        });
        if (!current()) return false;
        if (recorded) {
          setRun(null);
          setResult({ caseId: recorded.caseId, verdict: recorded });
          setDispatchPending(false);
          setError(null);
          setLoading(false);
          if (receiptKey.current !== recorded.id) {
            receiptKey.current = recorded.id;
            const receiptVersion = dashboard?.skill.currentVersion.id === versionId
              ? dashboard.skill.currentVersion.version
              : versionId;
            markSetupReceipt(`Evaluator v${receiptVersion} returned an assessment on recorded evidence.`);
            void refresh();
          }
          return false;
        }
        return true;
      }
      setRun(detail);
      setError(null);
      setLoading(false);

      const completedItem = detail.items.find((item) => item.status === "completed" && item.verdictId);
      if (completedItem) {
        const verdicts = await fetchCaseVerdicts(completedItem.caseId, {
          source: "llm_judge",
          skillVersionId: versionId,
          limit: 100
        });
        if (!current()) return false;
        const verdict = verdictForTrackedItem(verdicts, completedItem.verdictId!);
        if (!verdict) {
          setError("The tracked run finished, but its exact assessment record could not be loaded.");
          return false;
        }
        setResult({ caseId: completedItem.caseId, verdict });
        if (receiptKey.current !== detail.id) {
          receiptKey.current = detail.id;
          const receiptVersion = dashboard?.skill.currentVersion.id === versionId
            ? dashboard.skill.currentVersion.version
            : versionId;
          markSetupReceipt(
            `Evaluator v${receiptVersion} returned an assessment on recorded evidence.`
          );
          void refresh();
        }
      } else {
        setResult(null);
      }
      if (detail.status === "pending" || detail.status === "running") return true;
      if (completedItem) return false;
      // A listed active run can finish between reads. Check remaining work,
      // then recorded assessments, before stopping the onboarding poll.
      const remaining = await fetchEvalRuns(1, versionId, "first_assessment");
      if (!current()) return false;
      if (remaining.some((candidate) => candidate.status === "pending" || candidate.status === "running")) return true;
      const completed = await fetchProjectVerdicts({
        source: "llm_judge", skillVersionId: versionId, evidenceScope: "customer", limit: 1
      });
      return current() && completed.length > 0;
    } catch (cause) {
      if (current()) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      }
      return false;
    }
  }, [criterionId, dashboard, refresh, skillId, versionId]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    setRun(null);
    setResult(null);
    setError(null);
    setDispatchPending(false);
    setCanStartExisting(false);
    setLoading(true);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const keepPolling = await load(generation);
      if (!cancelled && keepPolling) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (loadGeneration.current === generation) loadGeneration.current += 1;
      if (timer) clearTimeout(timer);
    };
  }, [load, retryNonce]);

  const versionLabel = dashboard?.skill.currentVersion.id === versionId
    ? `v${dashboard.skill.currentVersion.version}`
    : "the saved evaluator";
  const completed = run?.completedItems ?? (result
    ? Math.max(1, dashboard?.skill.currentVersion.id === versionId ? dashboard.currentVersionResultCount : 0)
    : 0);
  const failed = run?.failedItems ?? 0;
  const total = run?.totalItems ?? dashboard?.project.importedTraceCount ?? 0;

  return (
    <div className="fadeUp max-w-[1180px]">
      <div className="mb-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          <ArrowLeft /> Back to Overview
        </Button>
      </div>
      <SectionHead
        eyebrow="First setup · assessment"
        title={result
          ? "Your first assessment is ready"
          : canStartExisting
            ? "Choose what to evaluate"
          : dispatchPending
            ? "Waiting to start the saved evaluator run"
            : `Applying ${versionLabel} to a recorded case`}
        sub={result
          ? "This is the evaluator's opinion about evidence your AI already produced. It is not a human decision, proof of accuracy, or permission to ship."
          : canStartExisting
            ? "No saved run is visible yet. New imports can start their own evaluations; evaluating existing cases is a separate choice."
          : dispatchPending
            ? "The case is saved, but Rubrist has not confirmed that evaluation started. No assessment exists yet."
            : "Rubrist is evaluating saved evidence. You can leave this page and return—the progress below is stored."}
      />

      {criterionError ? (
        <StatusCard
          urgent
          icon={<CircleAlert className="size-4" />}
          title="Could not verify which quality question produced this assessment"
          body={criterionError}
        />
      ) : versionId && skillId && criterionId && !criterionVersion ? (
        <StatusCard
          icon={<LoaderCircle className="size-4 animate-spin" />}
          title="Loading the saved quality question"
          body="Rubrist is verifying the exact evaluator definition bound to this assessment before showing its verdict."
        />
      ) : criterionVersion ? (
        <Card className="mb-4 border-gold-tint">
          <CardHeader>
            <div>
              <Eyebrow>This assessment answers</Eyebrow>
              <CardTitle className="mt-1">{criterionVersion.name}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="font-serif text-[20px] leading-7 text-ink">{criterionVersion.definition}</p>
            <p className="mt-3 text-[12px] leading-5 text-ink-2">
              Starter · unvalidated. The verdict below is this evaluator's model opinion, not proof that the evaluator is accurate.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {criterionError || (versionId && skillId && criterionId && !criterionVersion) ? null : loading && !run ? (
        <StatusCard
          icon={<LoaderCircle className="size-4 animate-spin" />}
          title="Preparing the evaluator run"
          body="Loading saved evaluation progress for this evaluator."
        />
      ) : error ? (
        <StatusCard
          urgent={!canStartExisting}
          icon={<CircleAlert className="size-4" />}
          title={canStartExisting ? "No evaluation run has started" : "Could not read the evaluation status"}
          body={error}
          actions={<>
            <Button size="sm" variant="outline" onClick={() => {
              setLoading(true);
              setError(null);
              nextEnsureAt.current = 0;
              setRetryNonce((value) => value + 1);
            }}>
              <RefreshCcw /> Try again
            </Button>
            {canStartExisting && skillId && versionId ? <Button size="sm" variant="outline" onClick={async () => {
              setCanStartExisting(false);
              try {
                await ensureSkillVersionBackfill(skillId, versionId);
                setRetryNonce((value) => value + 1);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
                setCanStartExisting(true);
              }
            }}>Evaluate existing cases</Button> : null}
          </>}
        />
      ) : dispatchPending && run && run.status === "pending" ? (
        <StatusCard
          urgent
          icon={<CircleAlert className="size-4" />}
          title="Case saved, waiting to enter the evaluation queue"
          body="Rubrist has not confirmed a live queue job yet. It will keep checking this saved run; no assessment has been produced or queued successfully yet."
          actions={
            <Button size="sm" variant="outline" onClick={() => {
              setLoading(true);
              nextEnsureAt.current = 0;
              setRetryNonce((value) => value + 1);
            }}>
              <RefreshCcw /> Try queueing again
            </Button>
          }
        />
      ) : run && (run.status === "pending" || run.status === "running") ? (
        <StatusCard
          icon={<LoaderCircle className="size-4 animate-spin" />}
          title={run.status === "pending" ? "Evaluator queued" : "Checking recorded evidence"}
          body={`${(completed + failed).toLocaleString()} of ${total.toLocaleString()} recorded ${total === 1 ? "Case" : "Cases"} finished${failed > 0 ? ` · ${failed} could not run` : ""}.`}
        />
      ) : run && !result ? (
        <StatusCard
          urgent
          icon={<CircleAlert className="size-4" />}
          title="The first assessment could not be produced"
          body={`${run.error ?? `${failed.toLocaleString()} of ${total.toLocaleString()} evaluator attempts failed before an assessment was recorded.`} Fix the provider setup if needed, then save a new evaluator version to try again.`}
          actions={
            <>
              <Button size="sm" variant="outline" onClick={() => navigate(dashboard?.viewerRole === "owner" ? "/skill/edit" : "/skill")}>
                {dashboard?.viewerRole === "owner" ? "Review the evaluator" : "View evaluator"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate("/settings")}>
                Check provider settings
              </Button>
            </>
          }
        />
      ) : result ? (
        <Card className="border-gold-tint" role="status" aria-live="polite" aria-atomic="true">
          <CardHeader>
            <div>
              <Eyebrow>Recorded evaluator assessment · {versionLabel}</Eyebrow>
              <CardTitle className="mt-1">What the evaluator concluded</CardTitle>
              <CardDescription>
                {completed.toLocaleString()} of {total.toLocaleString()} recorded {total === 1 ? "Case has" : "Cases have"} an assessment
                {failed > 0 ? ` · ${failed} could not run` : ""}.
              </CardDescription>
            </div>
            <div className="flex-1" />
            <VerdictChip verdict={verdictLabelFromPayload(result.verdict.payload)} />
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <Eyebrow>Why the evaluator said this</Eyebrow>
              <div className="mt-2 text-[13px] leading-[1.65] text-ink-2">
                {payloadRationale(result.verdict.payload) ?? <span className="text-ink-3">This evaluator states no rationale.</span>}
              </div>
              <Button
                className="mt-4"
                size="sm"
                variant="primary"
                onClick={() => navigate(`/cases/${result.caseId}`, {
                  state: { backTo: firstResultPath(versionId!, skillId!, criterionId!), backLabel: "Back to first assessment" }
                })}
              >
                Open the recorded case <ArrowRight />
              </Button>
            </div>
            <div className="border-t border-rule-soft pt-5 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
              <Eyebrow>What this does—and does not—show</Eyebrow>
              <div className="mt-2 text-[13px] leading-[1.65] text-ink-2">
                The evaluator read the stored input, output, and any recorded steps or tool calls. It did
                not replay tools or verify outside side effects. A person can review this assessment later,
                and that human label remains separate.
              </div>
              <Button className="mt-4" size="sm" variant="outline" onClick={() => navigate("/")}>
                Finish setup
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <StatusCard
          icon={<LoaderCircle className="size-4 animate-spin" />}
          title="Waiting for the tracked evaluator run"
          body="The evaluator passed its saved regression step. Its evaluation run will appear here as soon as it is created."
        />
      )}
    </div>
  );
}

function StatusCard({
  icon,
  title,
  body,
  actions,
  urgent = false
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  actions?: React.ReactNode;
  urgent?: boolean;
}) {
  return (
    <Card role={urgent ? "alert" : "status"} aria-live={urgent ? "assertive" : "polite"} aria-atomic="true">
      <CardContent className="py-8">
        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
          {icon}
          {title}
        </div>
        <div className="mt-2 max-w-[72ch] text-[12.5px] leading-[1.6] text-ink-3">{body}</div>
        {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
      </CardContent>
    </Card>
  );
}
