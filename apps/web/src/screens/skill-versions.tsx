import { evaluatorAuthorship } from "@rubrist/shared";
import { CheckWait } from "../components/check-wait.js";
import { PageLoading } from "../components/page-loading.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ChevronRight, Copy, Download, RefreshCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MarkdownPreview } from "@/components/markdown-preview";
import { BindingResolutionStatus } from "@/components/binding-resolution-status";
import { TypedQuestionView } from "@/components/typed-question-view";
import { regressionReceiptLabel, skillVersionChangeLabels } from "@/lib/skill-edit-flow";
import { Table } from "@/components/ui/table";
import { RowLink } from "@/components/row-action";
import { Eyebrow, SectionHead, Chip, GateChip, gateStateForVersion, LabelChip, MarginNote, PageLoadError, RegressionDiffTable, ConvergenceCard, SectionLoadError, SectionLoading } from "@/components/rubrist";
import { fetchLatestSkill, fetchJudgeCard, fetchJudgeCardMarkdown, fetchSkillFormat, fetchSkillVersionHistory, fetchSkillVersions, fetchSkillVersionRegression, fetchSkillVersionConvergence, fetchSkillVersionSelfConsistency } from "@/lib/api";
import { useCriterion } from "@/lib/criterion-context";
import { loadFailure, NO_SKILL_FAILURE, type LoadFailure } from "@/lib/load-error";
import { EvaluatorDefault, useCurrentDefault, defaultVersionLabel } from "../components/evaluator-default.js";
import { measuredCount } from "@/lib/regression-gate";
import { useSectionRead } from "@/hooks/use-section-read";
import { verdictKindDescription } from "@/lib/verdict-kind";
import { compileJudgePrompt, KAPPA_MIN_SHARED_CASES, type JudgeCard, type RegressionRunResult, type SelfConsistencyReport, type Skill, type SkillStatus, type SkillVersion, describeExecutionBinding } from "@rubrist/shared";

// Explicit mapping for every SkillStatus value. Reviewer scanning a versions
// ledger needs to distinguish approved (on-deck) from deprecated (end of life)
// at a glance — collapsing both to neutral "outline" hides material state.
// `assertNever` keeps future schema additions honest.
type ChipVariant = "pass" | "ambig" | "fail" | "outline" | "default";
const STATUS_VARIANT: Record<SkillStatus, ChipVariant> = {
  production:   "outline",
  approved:     "outline",
  validated:    "outline",
  calibrating:  "ambig",
  needs_review: "ambig",
  draft:        "ambig",
  regressing:   "fail",
  failed:       "fail",
  deprecated:   "outline"
};
const STATUS_LABEL: Record<SkillStatus, string> = {
  production:   "recorded: production",
  approved:     "recorded: approved",
  validated:    "recorded: validated",
  calibrating:  "regression running",
  needs_review: "needs review",
  draft:        "draft · held",
  regressing:   "regressing",
  failed:       "regression check failed",
  deprecated:   "deprecated"
};

// A governed candidate reads as calibrating for its whole candidate life. With
// its regression run recorded it is a candidate; with none, its check is
// running; while the run can't be read, the page can't tell which.
function StatusChip({ status, run }: { status: SkillStatus; run: RegressionRunResult | null | undefined }) {
  const label = status !== "calibrating"
    ? STATUS_LABEL[status]
    : run === undefined
      ? "calibrating"
      : run === null
        ? STATUS_LABEL.calibrating
        : "candidate";
  return <Chip variant={STATUS_VARIANT[status]}>{label}</Chip>;
}

export function SkillVersionsScreen() {
  const navigate = useNavigate();
  const { selectedCriterionId } = useCriterion();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [regressionRuns, setRegressionRuns] = useState<Record<string, RegressionRunResult>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadFailure | null>(null);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [loadedCriterion, setLoadedCriterion] = useState<string | null | undefined>(undefined);
  const loadGeneration = useRef(0);
  const scopeLoaded = loadedCriterion === selectedCriterionId;
  const defaultRead = useCurrentDefault(loading || !scopeLoaded ? null : skill, selectedCriterionId, `${selectedCriterionId ?? ""}:${selectionRevision}`);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const s = await fetchLatestSkill(selectedCriterionId ?? undefined);
      const history = await fetchSkillVersionHistory(s.id, 50);
      if (generation !== loadGeneration.current) return;
      setSkill(s);
      setLoadedCriterion(selectedCriterionId);
      setVersions(history.versions);
      setRegressionRuns(Object.fromEntries(history.regressionRuns.map((run) => [run.skillVersionId, run])));
    } catch (err) {
      if (generation === loadGeneration.current) {
        setError(loadFailure(err));
        setLoadedCriterion(selectedCriterionId);
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [selectedCriterionId]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  // Async regression check (M0 C5b): a `calibrating` version without a recorded
  // run is a gate.run in flight — poll quietly until its run lands so the
  // history updates without a manual refresh. A governed candidate stays
  // calibrating after its run is recorded, so it only keeps a slow poll: the
  // versions and runs are separate reads, and a check that lands between them
  // shows a run on a still-calibrating version until the next tick.
  // Silent refetch (no setLoading) to avoid a shell flash on every tick; the
  // interval tears down once nothing is calibrating.
  const anyCheckRunning = versions.some((candidate) => candidate.status === "calibrating" && !regressionRuns[candidate.id]);
  const anyCalibrating = versions.some((candidate) => candidate.status === "calibrating");
  const pollInterval = anyCheckRunning ? 3_000 : anyCalibrating ? 30_000 : null;
  useEffect(() => {
    if (pollInterval === null) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const s = await fetchLatestSkill(selectedCriterionId ?? undefined);
          const history = await fetchSkillVersionHistory(s.id, 50);
          if (cancelled) return;
          setSkill(s);
          setSelectionRevision((value) => value + 1);
          setVersions(history.versions);
          setRegressionRuns(Object.fromEntries(history.regressionRuns.map((run) => [run.skillVersionId, run])));
        } catch {
          // Transient poll failure keeps last-good state; next tick retries.
        }
      })();
    }, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollInterval, selectedCriterionId]);

  if (!scopeLoaded || (loading && versions.length === 0)) {
    return (
      <PageLoading title="Loading versions" shape="list" />
    );
  }

  if (error || !skill) {
    return (
      <PageLoadError
        eyebrow="Every version of the skill"
        title="Couldn't load versions"
        failure={error ?? NO_SKILL_FAILURE}
        onRetry={() => void load()}
        back={
          <Button variant="ghost" onClick={() => navigate("/criteria")}>
            Open criteria
          </Button>
        }
      />
    );
  }

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Immutable evaluator history"
        title="Evaluator versions"
        sub="Each row is a saved evaluator version with its model settings and recorded Golden-set check. Open a version to inspect its definition (a guide and prompt, or a typed question), result format, and evidence attached to it."
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCcw /> Refresh
            </Button>
            {versions.length >= 2 ? (
              <Button variant="default" size="sm" onClick={() => navigate("/skill/compare")}>
                Compare versions
              </Button>
            ) : null}
          </div>
        }
      />

      <EvaluatorDefault read={defaultRead} />

      <Card className="mb-6">
        <Table className="ledger-stacked" role="table" aria-label="Evaluator versions">
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader" style={{ width: 110 }}>Version</th>
              <th scope="col" role="columnheader" style={{ width: 140 }}>Status</th>
              <th scope="col" role="columnheader">Changes / model</th>
              <th scope="col" role="columnheader" style={{ width: 120 }} className="text-right">
                Golden agree
              </th>
              <th scope="col" role="columnheader" style={{ width: 80 }} className="text-right">
                Strict
              </th>
              <th scope="col" role="columnheader" style={{ width: 80 }} className="text-right">
                Lenient
              </th>
              <th scope="col" role="columnheader" style={{ width: 150 }}>Recorded</th>
              <th scope="col" role="columnheader" style={{ width: 30 }}></th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {versions.length === 0 ? (
              <tr role="row">
                <td colSpan={8} className="text-center text-ink-3">
                  No versions recorded yet.
                </td>
              </tr>
            ) : null}
            {versions.map((v, index) => {
              const regressionRun = regressionRuns[v.id];
              const agreementPct =
                v.goldenSetAgreement == null || regressionRun?.compared === 0 ? null : Math.round(v.goldenSetAgreement * 100);
              const changes = skillVersionChangeLabels(v, versions[index + 1]);
              const receiptLabel = regressionReceiptLabel(regressionRun);
              const receiptAt = regressionRun?.createdAt ?? v.approvedAt;
              return (
                <tr
                  role="row"
                  key={v.id}
                  className="row-link"
                  onClick={() => navigate(`/skill/versions/${v.id}`)}
                >
                  <td role="cell" data-label="Version">
                    <RowLink to={`/skill/versions/${v.id}`} className="font-mono text-ink">
                      v{v.version}
                    </RowLink>
                  </td>
                  <td role="cell" data-label="Status">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Chip>{defaultVersionLabel(defaultRead, v.id)}</Chip>
                      {!["approved", "production", "validated"].includes(v.status) ? <StatusChip status={v.status} run={regressionRun ?? null} /> : null}
                      {v.status === "calibrating" && !regressionRun ? <CheckWait createdAt={v.createdAt} /> : null}
                      {v.onboardingAssurance === "starter_unvalidated" ? <Chip>Starter · unvalidated</Chip> : null}
                      <GateChip state={gateStateForVersion(v, regressionRun ?? null)} title={v.knownLimitations.join(" · ")} />
                    </div>
                  </td>
                  <td role="cell" data-label="Changes / model">
                    <div className="text-[13px] text-ink-2">
                      {changes.join(" · ")}
                    </div>
                    <div className="mt-0.5 font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
                      {v.executionBinding.provider}/{v.executionBinding.modelId}@{v.executionBinding.modelVersion}
                    </div>
                    {v.knownLimitations.length > 0 ? (
                      <div className="mt-0.5 text-[10.5px] text-signal">
                        {v.knownLimitations.length} known limitation{v.knownLimitations.length === 1 ? "" : "s"}
                      </div>
                    ) : null}
                  </td>
                  <td role="cell" data-label="Golden agree" className="text-left font-mono md:text-right tabular-nums">
                    {agreementPct == null ? "—" : (
                      <>
                        {agreementPct}
                        <span className="text-ink-3">%</span>
                      </>
                    )}
                  </td>
                  <td role="cell" data-label="Strict" className="text-left font-mono md:text-right tabular-nums">{measuredCount(v, v.tooStrictCount, regressionRun)}</td>
                  <td role="cell" data-label="Lenient" className="text-left font-mono md:text-right tabular-nums">{measuredCount(v, v.tooLenientCount, regressionRun)}</td>
                  <td role="cell" data-label="Recorded" className="font-mono text-ink-3">
                    <div title={v.createdAt}>
                      {new Date(v.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                    </div>
                    <div className="mt-0.5 text-[10px]">
                      {receiptAt
                        ? `${receiptLabel} ${new Date(receiptAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
                        : receiptLabel}
                    </div>
                  </td>
                  <td role="cell" aria-hidden="true" className="hidden md:table-cell">
                    <ChevronRight className="size-3 text-ink-3" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>

      <Card className="max-w-[80ch] border-dashed">
        <CardContent className="py-4">
          <Eyebrow>Why a Judge Card per version</Eyebrow>
          <div className="mt-2 font-serif text-[14px] leading-[1.55] tracking-[-0.005em] text-ink-2">
            A skill that judges other things must itself be judged. The card records the
            receipt: what model, what promoted reference cases, and what changed when this version was created.
            Every claim made against a trace links back to the card of the version that
            produced it.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function SkillVersionDetailScreen() {
  const navigate = useNavigate();
  const { selectedCriterionId } = useCriterion();
  const { id } = useParams<{ id: string }>();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<{ routeKey: string; failure: LoadFailure } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Which version and criterion `skill` and `versions` were read for. Until they
  // match the route, the page is still loading, never "not found", and another
  // route's failure never shows for this one.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const routeKey = `${selectedCriterionId ?? ""}|${id ?? ""}`;
  const error = failure !== null && failure.routeKey === routeKey ? failure.failure : null;

  useEffect(() => {
    let cancelled = false;
    const readFor = `${selectedCriterionId ?? ""}|${id ?? ""}`;
    setLoading(true);
    setFailure(null);
    (async () => {
      try {
        const s = await fetchLatestSkill(selectedCriterionId ?? undefined);
        if (cancelled) return;
        const vs = await fetchSkillVersions(s.id, 100);
        if (cancelled) return;
        setSkill(s);
        setVersions(vs);
        setLoadedFor(readFor);
      } catch (err) {
        if (!cancelled) setFailure({ routeKey: readFor, failure: loadFailure(err) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, selectedCriterionId, reloadKey]);

  const v = versions.find((vv) => vv.id === id) ?? null;


  // Each evidence read fails on its own: the version stays readable, a failed
  // section says so where its data would be, and its Retry reads only that
  // section again. fetchSkillVersionRegression maps "no recorded run" to null.
  const current = !loading && !error && loadedFor === routeKey;
  const defaultRead = useCurrentDefault(current ? skill : null, selectedCriterionId, `${routeKey}:${reloadKey}`);
  const evidence = current && skill && v ? { skillId: skill.id, versionId: v.id } : null;
  const evidenceKey = evidence ? `${evidence.skillId}:${evidence.versionId}` : null;
  const regression = useSectionRead(
    evidenceKey,
    evidence && (() => fetchSkillVersionRegression(evidence.skillId, evidence.versionId))
  );
  const convergence = useSectionRead(
    evidenceKey,
    evidence && (async () => (await fetchSkillVersionConvergence(evidence.skillId, evidence.versionId)).audit)
  );
  const consistency = useSectionRead(
    evidenceKey,
    evidence && (() => fetchSkillVersionSelfConsistency(evidence.skillId, evidence.versionId))
  );
  // the AUTHORITATIVE Judge Card, fetched from /card (κ + basis + audit)
  // — distinct from the client-side signal assembly on this screen.
  const judgeCard = useSectionRead(
    evidenceKey,
    evidence && (() => fetchJudgeCard(evidence.skillId, evidence.versionId))
  );
  // The recorded run, null when this version has none, and undefined while it
  // is read or when the read failed.
  const regressionRun = regression.status === "loaded" ? regression.data : undefined;
  const convergenceAudit = convergence.status === "loaded" ? convergence.data : null;

  const backToVersions = (
    <Button variant="ghost" size="sm" onClick={() => navigate("/skill/versions")}>
      <ArrowLeft /> Back to versions
    </Button>
  );

  // The page renders once its version is read. Each evidence section then
  // says it is loading until its own read settles, so a slow section never
  // holds up the rest and never reads as empty meanwhile.
  if (!current && !error) {
    return (
      <PageLoading title="Loading version" />
    );
  }

  if (error) {
    return (
      <PageLoadError
        eyebrow="Judge card"
        title="Couldn't load this version"
        failure={error}
        onRetry={() => setReloadKey((key) => key + 1)}
        back={backToVersions}
      />
    );
  }

  if (!v) {
    return (
      <div className="fadeUp">
        <div className="mb-3">{backToVersions}</div>
        <SectionHead eyebrow="Judge card" title="Version not found" />
        <Card>
          <CardContent className="text-[13px] text-ink-2">
            This version may have been archived or removed.
          </CardContent>
        </Card>
      </div>
    );
  }

  const agreementPct = v.goldenSetAgreement == null || regressionRun?.compared === 0 ? null : Math.round(v.goldenSetAgreement * 100);
  const compiledPrompt = v.typedQuestion === null ? compileJudgePrompt({ prompt: v.prompt ?? "", rubricMarkdown: v.rubricMarkdown ?? "" }) : null;

  return (
    <div className="fadeUp max-w-[1760px]">
      <div className="mb-3 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate("/skill/versions")}>
          <ArrowLeft /> Back to versions
        </Button>
        <div className="flex items-center gap-2 font-mono text-[11px] text-ink-3">
          <span>v{v.version}</span>
          <span>·</span>
          <span>
            {v.executionBinding.provider}/{v.executionBinding.modelId}@{v.executionBinding.modelVersion}
          </span>
        </div>
      </div>

      <SectionHead
        eyebrow={`Judge card · v${v.version}`}
        title={`${v.executionBinding.provider}/${v.executionBinding.modelId}`}
        sub={`Saved ${new Date(v.createdAt).toLocaleString()} · ${v.knownLimitations.length} known limitation${v.knownLimitations.length === 1 ? "" : "s"}`}
      />

      <EvaluatorDefault read={defaultRead} versionId={v.id} />
      <section aria-label="Reference check evidence" className="mb-5 rounded-sm border border-rule-soft px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium">Known-failure reference check</span>
          <GateChip state={regression.status === "loading" ? "loading" : gateStateForVersion(v, regressionRun)} />
          {regressionRun ? <span className="text-[12px] text-ink-2">{regressionRun.compared} reference cases compared</span> : null}
          {v.onboardingAssurance === "starter_unvalidated" ? <Chip>Starter · unvalidated</Chip> : null}
        </div>
        <p className="mt-1 text-[12px] leading-5 text-ink-2">This checks known failures on the pinned reference set. It does not establish general accuracy or sealed calibration.</p>
        <details className="mt-2 text-[11.5px] text-ink-3">
          <summary className="cursor-pointer">Recorded lifecycle details</summary>
          <p className="mt-1">Recorded status: {v.status}. Approval timestamp: {v.approvedAt ? new Date(v.approvedAt).toLocaleString() : "not recorded"}. These fields do not identify the current default or replace scoped validation evidence.</p>
        </details>
      </section>

      {judgeCard.status === "loading" ? (
        <SectionLoading className="mb-6" label="Loading the Judge Card…" />
      ) : judgeCard.status === "failed" ? (
        <SectionLoadError
          className="mb-6"
          title="Couldn't load the Judge Card."
          failure={judgeCard.failure}
          retrying={judgeCard.retrying}
          onRetry={judgeCard.retry}
        />
      ) : judgeCard.status === "loaded" && skill ? (
        <JudgeCardPanel card={judgeCard.data} skillId={skill.id} versionId={v.id} />
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.3fr_1fr]">
        <div className="flex flex-col gap-5">
          {v.typedQuestion !== null ? (
            <Card>
              <CardContent className="py-4">
                <TypedQuestionView question={v.typedQuestion} threshold={v.decisionThreshold} />
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardContent className="py-4">
                  <Eyebrow>Review guide · stored as Markdown</Eyebrow>
                  <p className="mt-2 text-[12px] leading-5 text-ink-2">
                    Defines what a good result looks like and the evidence this evaluator should use.
                  </p>
                  <MarkdownPreview markdown={v.rubricMarkdown ?? ""} className="mt-3 max-h-[520px]" />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="py-4">
                  <Eyebrow>Judge instructions · exact compiled text</Eyebrow>
                  <p className="mt-2 text-[12px] leading-5 text-ink-2">
                    Exact source sent to the judge after inserting the review guide. It is intentionally
                    not rendered as Markdown.
                  </p>
                  <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rule-soft bg-card-2 px-3 py-3 font-mono text-[12px] leading-[1.6] text-ink">
                    {compiledPrompt?.content || <span className="text-ink-3">No judge instructions recorded.</span>}
                  </pre>
                </CardContent>
              </Card>
            </>
          )}
        </div>

        <div className="flex flex-col gap-5">
          <Card>
            <CardContent className="py-4">
              <Eyebrow>Known-failure regression</Eyebrow>
              <p className="mt-2 text-[12px] leading-5 text-ink-2">
                Compares this version with promoted reference cases. It does not measure overall
                evaluator quality or make a release decision.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
                <div className="text-ink-3">Known-failure agreement</div>
                <div className="font-mono">
                  {agreementPct == null ? "—" : `${agreementPct}%`}
                </div>
                <div className="text-ink-3">Too strict</div>
                <div className="font-mono">{measuredCount(v, v.tooStrictCount, regressionRun)}</div>
                <div className="text-ink-3">Too lenient</div>
                <div className="font-mono">{measuredCount(v, v.tooLenientCount, regressionRun)}</div>
                <div className="text-ink-3">Ambiguous</div>
                <div className="font-mono">{measuredCount(v, v.ambiguousCount, regressionRun)}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <Eyebrow>Execution binding · immutable settings</Eyebrow>
              <p className="mt-2 text-[12px] leading-5 text-ink-2">
                Exactly what every judge call of this immutable version sends. Individual runs retain
                the provider-reported identity separately when available.
              </p>
              <div className="mt-2 grid grid-cols-1 gap-y-1 text-[13px] sm:grid-cols-[140px_1fr] sm:gap-y-2">
                <div className="text-ink-3">Provider</div>
                <div>{v.executionBinding.provider}</div>
                <div className="text-ink-3">Model id</div>
                <div className="font-mono">{v.executionBinding.modelId}</div>
                <div className="text-ink-3">Model version</div>
                <div className="font-mono">{v.executionBinding.modelVersion}</div>
                <div className="text-ink-3">Binding</div>
                <div className="font-mono">{describeExecutionBinding(v.executionBinding)}</div>
                <div className="text-ink-3">Result type</div>
                <div>
                  <div className="font-mono">{v.verdictKind}</div>
                  <div className="mt-0.5 text-[11.5px] leading-5 text-ink-3">
                    {verdictKindDescription(v.verdictKind, {
                      scalarRange: v.scalarRange,
                      categoricalChoiceScores: v.categoricalChoiceScores,
                      decisionThreshold: v.decisionThreshold
                    })}
                  </div>
                </div>
                <div className="text-ink-3">Pinned corpus</div>
                <div className="break-all font-mono text-[11px]" title={v.regressionDatasetRevisionId ?? undefined}>
                  {v.regressionDatasetRevisionId ?? "not pinned"}
                </div>
              </div>
            </CardContent>
          </Card>

          <BindingResolutionStatus key={v.id} skillVersionId={v.id} />

          {v.knownLimitations.length > 0 ? (
            <Card>
              <CardContent className="py-4">
                <Eyebrow>Known limitations</Eyebrow>
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-[12.5px] text-ink-2">
                  {v.knownLimitations.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardContent className="py-4">
              <Eyebrow>Result format · exact JSON schema</Eyebrow>
              <p className="mt-2 text-[12px] leading-5 text-ink-2">
                Fields and allowed values the judge must return. Rubrist validates results against
                this exact contract, so it remains source text rather than Markdown.
              </p>
              <pre className="mt-3 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rule-soft bg-card-2 px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-ink">
                {v.outputSchema != null && Object.keys(v.outputSchema as object).length > 0 ? (
                  JSON.stringify(v.outputSchema, null, 2)
                ) : (
                  <span className="text-ink-3">No schema recorded.</span>
                )}
              </pre>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-6">
        {regression.status === "loading" ? (
          <SectionLoading label="Loading the regression run…" />
        ) : regression.status === "failed" ? (
          <SectionLoadError
            title="Couldn't load the regression run."
            failure={regression.failure}
            retrying={regression.retrying}
            onRetry={regression.retry}
          />
        ) : regressionRun && regressionRun.cases.length > 0 ? (
          <RegressionDiffTable
            cases={regressionRun.cases}
            title="Regression at version creation"
            description={`The immutable reference revision pinned when this version was created was re-judged${regressionRun.datasetRevisionId ? ` (${regressionRun.datasetRevisionId})` : ""}. Click a row to open the trace.`}
          />
        ) : regressionRun && regressionRun.compared > 0 ? (
          <MarginNote tone="neutral" who="Regression">
            {regressionRun.compared} case{regressionRun.compared === 1 ? "" : "s"} were re-judged when this
            version was created, but this run didn't capture a per-case breakdown (older run format).
          </MarginNote>
        ) : null}
      </div>

      {convergence.status === "loading" ? (
        <SectionLoading className="mt-6" label="Loading the convergence audit…" />
      ) : convergence.status === "failed" ? (
        <div className="mt-6">
          <SectionLoadError
            title="Couldn't load the convergence audit."
            failure={convergence.failure}
            retrying={convergence.retrying}
            onRetry={convergence.retry}
          />
        </div>
      ) : convergenceAudit ? (
        <div className="mt-6">
          <ConvergenceCard
            audit={convergenceAudit}
            versionLabel={`v${v.version}`}
            beforeVersionLabel={
              convergenceAudit.beforeVersionId
                ? (() => {
                    const before = versions.find((vv) => vv.id === convergenceAudit.beforeVersionId);
                    return before ? `v${before.version}` : null;
                  })()
                : null
            }
          />
        </div>
      ) : null}

      <div className="mt-6">
        {consistency.status === "failed" ? (
          <SelfConsistencyCard
            report={null}
            failure={consistency.failure}
            retrying={consistency.retrying}
            onRetry={consistency.retry}
          />
        ) : (
          <SelfConsistencyCard
            report={consistency.status === "loaded" ? consistency.data : null}
            loading={consistency.status === "loading"}
          />
        )}
      </div>
    </div>
  );
}

// self-consistency — one of the three trust signals, and the weakest on
// its own: a judge can be perfectly consistent and consistently wrong. Framed
// as "does the requested model repeat itself", never as correctness.
// the attested Judge Card — rendered FROM the /card JSON (not
// re-derived), with Markdown export/copy that pull /card?format=md so what's
// shown, copied, and downloaded all trace to the same attested source. Names
// and free-text arrive already escaped from the server (C1); React text nodes
// escape them again on render — belt and suspenders.
function JudgeCardPanel({ card, skillId, versionId }: { card: JudgeCard; skillId: string; versionId: string }) {
  const [copied, setCopied] = useState(false);
  const [exportError, setExportError] = useState(false);
  const copyMarkdown = useCallback(async () => {
    try {
      const md = await fetchJudgeCardMarkdown(skillId, versionId);
      await navigator.clipboard?.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* copy is best-effort; export is the reliable path */
    }
  }, [skillId, versionId]);
  // Export via a fetch+blob download, NOT an anchor navigation: an anchor
  // cannot send the x-rubrist-project header, so the server would resolve the
  // caller's oldest project and could export a DIFFERENT project's card than
  // the panel shows. fetchJudgeCardMarkdown sends the header → exported bytes
  // always match this panel's project.
  const exportMarkdown = useCallback(async () => {
    setExportError(false);
    try {
      const md = await fetchJudgeCardMarkdown(skillId, versionId);
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `rubrist-judge-card-${stamp}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError(true);
    }
  }, [skillId, versionId]);
  // skill-format/v1 JSON export, the same project-scoped blob download.
  const exportSkillFormat = useCallback(async () => {
    setExportError(false);
    try {
      const doc = await fetchSkillFormat(skillId, versionId);
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `rubrist-skill-format-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError(true);
    }
  }, [skillId, versionId]);

  const agreement = card.goldenSet.agreement;
  return (
    <Card className="mb-6 border-l-2 border-l-ink/40" data-judge-card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Eyebrow>Judge Card · recorded evidence · {card.version.version}</Eyebrow>
            <div className="mt-1 text-[11px] text-ink-3">
              This card contains recorded evidence for one evaluator version. It keeps each signal
              separate and does not turn them into a combined score.
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="default" size="sm" onClick={() => void exportMarkdown()} data-card-export>
              <Download /> {exportError ? "Export failed" : "Export as Markdown"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void copyMarkdown()} data-card-copy>
              <Copy /> {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void exportSkillFormat()} data-skillformat-export>
              <Download /> SkillFormat
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[12.5px]">
          <div className="text-ink-3">Execution binding</div>
          <div className="font-mono">{describeExecutionBinding(card.executionBinding)}</div>
          <div className="text-ink-3">Evaluator authorship</div>
          <div>
            <div>{evaluatorAuthorship(card.version).label}</div>
            <p className="mt-1 text-[11px] leading-4 text-ink-3">{evaluatorAuthorship(card.version).note}</p>
          </div>
          <div className="text-ink-3">Known-failure agreement</div>
          <div className="font-mono">
            {agreement === null || card.regression?.compared === 0
              ? "no comparable promoted reference cases"
              : `recorded ratio ${agreement.toFixed(2)}${card.regression ? ` over ${card.regression.compared} case(s) at version creation` : ""}`}
          </div>
          <div className="text-ink-3">Evaluator regression</div>
          <div className="font-mono">
            {card.regression
              ? card.regression.status === "passed" && card.regression.compared === 0
                ? "No reference cases compared"
                : `${card.regression.status} · ${card.regression.compared} compared, ${card.regression.regressed} regressed, ${card.regression.flipped} flipped`
              : "no recorded run"}
          </div>
          <div className="text-ink-3">Judge–human κ</div>
          <div className="font-mono">
            {card.judgeHumanKappa.filter((pair) => pair.cases >= KAPPA_MIN_SHARED_CASES).length === 0
              ? card.judgeHumanKappa.length === 0
                ? "none recorded yet"
                : `gathering evidence · ${Math.min(Math.max(...card.judgeHumanKappa.map((pair) => pair.cases)), KAPPA_MIN_SHARED_CASES)}/${KAPPA_MIN_SHARED_CASES} shared cases`
              : card.judgeHumanKappa
                  .filter((pair) => pair.cases >= KAPPA_MIN_SHARED_CASES)
                  .map((p) => `${p.kappa.toFixed(2)} (${p.interpretation.replace("_", " ")}) vs ${p.humanRater} · ${p.cases}`)
                  .join(" · ")}
          </div>
          <div className="text-ink-3">Self-consistency</div>
          <div className="font-mono">
            {card.selfConsistency
              ? `${card.selfConsistency.consistentCases}/${card.selfConsistency.comparedCases} repeated cases returned the same verdict; repeated answers can still be wrong`
              : "not probed yet"}
          </div>
        </div>

        <div className="mt-4">
          <Eyebrow>Basis</Eyebrow>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-[11.5px] leading-[1.5] text-ink-2" data-card-basis>
            {card.basis.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function SelfConsistencyCard({
  report,
  loading = false,
  failure,
  retrying = false,
  onRetry
}: {
  report: SelfConsistencyReport | null;
  loading?: boolean;
  failure?: LoadFailure;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-1 flex items-baseline justify-between">
          <Eyebrow>Self-consistency</Eyebrow>
          {report && report.comparedCases > 0 ? (
            <span className="font-mono text-[11px] text-ink-3">
              {report.consistentCases}/{report.comparedCases} cases fully consistent · mean{" "}
              {report.meanAgreement === null ? "—" : report.meanAgreement.toFixed(2)}
            </span>
          ) : null}
        </div>
        {loading ? (
          <SectionLoading label="Loading self-consistency…" />
        ) : failure && onRetry ? (
          <SectionLoadError
            className="mt-2"
            title="Couldn't load self-consistency."
            failure={failure}
            retrying={retrying}
            onRetry={onRetry}
          />
        ) : !report || report.comparedCases === 0 ? (
          <div className="text-[12.5px] leading-[1.55] text-ink-3">
            No repeat runs under this version yet. Re-judge a case with <code>force: true</code> on{" "}
            <code>POST /api/v1/judge</code> (or re-run a dataset eval) to probe whether the requested
            model repeats its own verdicts.
          </div>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Runs</th>
                  <th>Majority label</th>
                  <th>Distinct labels</th>
                  <th>Agreement</th>
                </tr>
              </thead>
              <tbody>
                {report.cases.map((entry) => (
                  <tr key={entry.caseId} className={entry.distinctLabels > 1 ? "row-signal" : undefined}>
                    <td className="font-mono text-[11px]">{entry.caseId}</td>
                    <td className="font-mono text-[11px]">{entry.runs}</td>
                    <td><LabelChip label={entry.majorityLabel} /></td>
                    <td className="font-mono text-[11px]">{entry.distinctLabels}</td>
                    <td className="font-mono text-[11px]">{entry.agreement.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="mt-2 text-[11px] text-ink-3">
              This measures only whether the evaluator repeated its verdict on cases judged at
              least twice. A repeated verdict can still be wrong, so read it separately from
              Golden-set agreement and convergence with human rulings.
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
