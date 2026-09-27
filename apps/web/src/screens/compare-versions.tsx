import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, RefreshCcw } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table } from "@/components/ui/table";
import { RowLink } from "@/components/row-action";
import {
  Chip,
  Eyebrow,
  GateChip,
  gateStateForVersion,
  KPI,
  KPIRow,
  PageLoadError,
  Ref,
  SectionHead
} from "@/components/rubrist";
import {
  fetchCurrentSkill,
  fetchSkillVersionRegression,
  fetchSkillVersions
} from "@/lib/api";
import type { SkillVersion } from "@rubrist/shared";
import { useCriterion } from "@/lib/criterion-context";
import { loadFailure, type LoadFailure } from "@/lib/load-error";
import {
  chainImprovementsGap,
  chainRecordedNote,
  chainStepRun,
  chainTotals,
  chainTotalsGap,
  loadChainStep,
  runCompared,
  type ChainStep
} from "@/lib/compare-chain";

// P1-3 · run comparison. Compare any two versions over the known-failure set by
// chaining the RECORDED per-save regression runs between them — every number
// comes from a run that actually happened; nothing synthetic is computed.
export function CompareVersionsScreen() {
  const navigate = useNavigate();
  const { selectedCriterionId } = useCriterion();
  const [searchParams, setSearchParams] = useSearchParams();

  const [skillId, setSkillId] = useState<string | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]); // newest → oldest
  const [listLoading, setListLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadFailure | null>(null);
  const [listReloadKey, setListReloadKey] = useState(0);
  // The recorded runs for one path, keyed by it so another pair's runs never
  // show for this one.
  const [chain, setChain] = useState<{ key: string; steps: ChainStep[]; baseline: ChainStep } | null>(null);
  const [stepsReloadKey, setStepsReloadKey] = useState(0);

  const fromId = searchParams.get("from");
  const toId = searchParams.get("to");

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const skill = await fetchCurrentSkill(selectedCriterionId ?? undefined);
        const list = await fetchSkillVersions(skill.id, 200);
        if (cancelled) return;
        setSkillId(skill.id);
        setVersions(list);
        // Default pair: previous → newest. A criterion switch can leave
        // the other lineage's version ids in the URL, so replace stale pairs
        // while preserving the criterion selector and other query state.
        const hasSelectedPair = Boolean(
          fromId && toId
          && list.some((version) => version.id === fromId)
          && list.some((version) => version.id === toId),
        );
        if (!hasSelectedPair && list.length >= 2) {
          setSearchParams(
            (current) => {
              const next = new URLSearchParams(current);
              next.set("from", list[1]!.id);
              next.set("to", list[0]!.id);
              return next;
            },
            { replace: true }
          );
        }
      } catch (err) {
        if (!cancelled) setLoadError(loadFailure(err));
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCriterionId, listReloadKey]);

  const iFrom = versions.findIndex((v) => v.id === fromId);
  const iTo = versions.findIndex((v) => v.id === toId);
  const valid = iFrom >= 0 && iTo >= 0 && iFrom > iTo; // from must be older
  const from = (valid ? versions[iFrom] : null) ?? null;
  const to = (valid ? versions[iTo] : null) ?? null;

  // The chain: each version between `to` (inclusive) and `from` (exclusive),
  // newest → oldest. Each one's regression run is the record of the save
  // that produced it.
  const chainVersions = useMemo(
    () => (valid ? versions.slice(iTo, iFrom) : []),
    [versions, valid, iTo, iFrom]
  );

  const chainKey = skillId && from && chainVersions.length > 0
    ? `${skillId}|${from.id}|${chainVersions.map((version) => version.id).join(",")}`
    : null;

  useEffect(() => {
    if (!chainKey || !skillId || !from) return;
    let cancelled = false;
    void (async () => {
      // A failed read stays a failure; it never reads as "no run recorded".
      // `from` is read too: the oldest save's improvements are counted
      // against its verdicts.
      const read = (version: SkillVersion) =>
        loadChainStep(version, () => fetchSkillVersionRegression(skillId, version.id));
      const [steps, baseline] = await Promise.all([Promise.all(chainVersions.map(read)), read(from)]);
      if (!cancelled) setChain({ key: chainKey, steps, baseline });
    })();
    return () => {
      cancelled = true;
    };
    // chainKey names skillId, from, and chainVersions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey, stepsReloadKey]);

  // null until every run on this path has been read. A retry keeps the rows
  // it is re-reading in place.
  const loaded = chain !== null && chain.key === chainKey ? chain : null;
  const steps = loaded?.steps ?? null;
  const totals = useMemo(() => (loaded ? chainTotals(loaded.steps, loaded.baseline) : null), [loaded]);
  const totalsNote = (complete: string) =>
    totals === null ? "loading recorded runs" : chainTotalsGap(totals) ?? complete;
  const improvementsNote = (complete: string) =>
    totals === null || loaded === null
      ? "loading recorded runs"
      : chainImprovementsGap(totals, loaded.baseline) ?? complete;

  // The newest step's per-case diff — the recorded record of the final hop.
  const newestStep = steps?.[0];
  const newestRun = newestStep?.status === "recorded" ? newestStep.run : null;

  function setPair(nextFrom: string, nextTo: string) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("from", nextFrom);
      next.set("to", nextTo);
      return next;
    }, { replace: true });
  }

  if (loadError) {
    return (
      <PageLoadError
        eyebrow="Run comparison"
        title="Couldn't load versions"
        failure={loadError}
        onRetry={() => setListReloadKey((key) => key + 1)}
        back={
          <Button variant="ghost" onClick={() => navigate("/criteria")}>
            Open criteria
          </Button>
        }
      />
    );
  }

  // The list is empty while it loads; that is not "nothing to compare".
  if (listLoading) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Run comparison" title="Loading versions" />
      </div>
    );
  }

  if (versions.length < 2) {
    return (
      <div className="fadeUp">
        <SectionHead
          eyebrow="Run comparison"
          title="Nothing to compare yet"
          sub="Save at least two evaluator versions before comparing them. Each successful save adds one immutable version to the history."
        />
        <Button variant="default" onClick={() => navigate("/skill/versions")}>
          <ArrowLeft /> All versions
        </Button>
      </div>
    );
  }

  const agreementPct = (v: SkillVersion | null) =>
    v?.goldenSetAgreement == null ? null : Math.round(v.goldenSetAgreement * 100);
  const fromPct = agreementPct(from);
  const toPct = agreementPct(to);

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Evaluator-version comparison · known-failure set"
        title="What changed between two versions"
        sub="Compare the recorded Golden-set checks for two evaluator versions. If the versions are not adjacent, this page combines the saved checks between them; it does not invent missing results."
        right={
          <Button variant="ghost" size="sm" onClick={() => navigate("/skill/versions")}>
            <ArrowLeft /> All versions
          </Button>
        }
      />

      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-center gap-3 py-3.5">
          <Eyebrow>From</Eyebrow>
          <VersionPick
            versions={versions}
            value={fromId}
            exclude={toId}
            onChange={(id) => setPair(id, toId ?? versions[0]!.id)}
          />
          <span className="font-mono text-ink-4">→</span>
          <Eyebrow>To</Eyebrow>
          <VersionPick
            versions={versions}
            value={toId}
            exclude={fromId}
            onChange={(id) => setPair(fromId ?? versions[versions.length - 1]!.id, id)}
          />
          <div className="flex-1" />
          {valid ? (
            <span className="font-mono text-[11px] text-ink-4">
              {chainVersions.length} {chainVersions.length === 1 ? "save" : "saves"} between them
              {totals ? ` · ${chainRecordedNote(totals)}` : ""}
            </span>
          ) : (
            <span className="font-mono text-[11px] text-signal">
              "from" must be the older version — swap the pickers
            </span>
          )}
        </CardContent>
      </Card>

      {valid && from && to ? (
        <>
          <KPIRow className="mb-5">
            <KPI
              label="Known-failure agreement"
              num={
                fromPct == null || toPct == null ? "—" : `${fromPct} → ${toPct}`
              }
              {...(fromPct != null && toPct != null ? { unit: "%" } : {})}
              delta={
                fromPct == null || toPct == null
                  ? "not measured on both"
                  : toPct > fromPct
                    ? "improved"
                    : toPct < fromPct
                      ? "declined"
                      : "unchanged"
              }
              deltaKind={
                fromPct != null && toPct != null && toPct < fromPct ? "signal" : "up"
              }
            />
            <KPI
              label="Regressions across versions"
              num={totals?.regressed ?? "—"}
              delta={totalsNote("changes against recorded labels")}
              deltaKind={totals?.regressed ? "signal" : "default"}
            />
            <KPI
              label="Improvements"
              num={totals?.improved ?? "—"}
              delta={improvementsNote("flips toward the label")}
            />
            <KPI
              label="Saves between"
              num={chainVersions.length}
              foot={totals ? chainRecordedNote(totals) : "loading recorded runs"}
            />
          </KPIRow>

          <Card className="mb-5">
            <CardHeader>
              <div>
                <CardTitle>The path, run by run</CardTitle>
                <CardDescription>
                  Each row is one saved version and the regression check recorded when it was saved, if any.
                </CardDescription>
              </div>
              {steps?.some((step) => step.status === "failed" && step.retryable) ? (
                <>
                  <div className="flex-1" />
                  <Button variant="ghost" size="sm" onClick={() => setStepsReloadKey((key) => key + 1)}>
                    <RefreshCcw /> Retry
                  </Button>
                </>
              ) : null}
            </CardHeader>
            <Table>
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Run</th>
                  <th style={{ width: 170 }}>Regression check</th>
                  <th style={{ width: 170 }}>Pinned corpus</th>
                  <th style={{ width: 100 }} className="text-right">Regressed</th>
                  <th style={{ width: 100 }} className="text-right">Improved</th>
                  <th>On the record</th>
                </tr>
              </thead>
              <tbody>
                {steps === null ? (
                  <tr>
                    <td colSpan={6} className="text-center text-ink-3">Loading recorded runs…</td>
                  </tr>
                ) : (
                  steps.map((step) => {
                    const { version } = step;
                    const run = step.status === "recorded" ? step.run : null;
                    // A failed or empty check recorded zeros it never measured.
                    const measured = run !== null && runCompared(run);
                    return (
                      <tr
                        key={version.id}
                        className="row-link"
                        onClick={() => navigate(`/skill/versions/${version.id}`)}
                      >
                        <td>
                          <RowLink to={`/skill/versions/${version.id}`} className="font-mono">
                            v{version.version}
                          </RowLink>
                        </td>
                        <td>
                          <GateChip
                            state={gateStateForVersion(version, chainStepRun(step))}
                            title={version.knownLimitations.join(" · ")}
                          />
                        </td>
                        <td
                          className="font-mono text-[10px] text-ink-3"
                          title={run?.datasetRevisionId ?? version.regressionDatasetRevisionId ?? undefined}
                        >
                          {(run?.datasetRevisionId ?? version.regressionDatasetRevisionId)?.slice(0, 18) ?? "not pinned"}
                          {(run?.datasetRevisionId ?? version.regressionDatasetRevisionId) ? "…" : ""}
                        </td>
                        <td
                          className="text-right font-mono tabular-nums"
                          style={measured && run.regressed ? { color: "var(--signal)" } : undefined}
                        >
                          {measured ? run.regressed : "—"}
                        </td>
                        <td className="text-right font-mono tabular-nums">{measured ? run.improved : "—"}</td>
                        <td className="text-[12.5px] text-ink-3">
                          {step.status === "failed" ? (
                            <span className="text-signal" title={step.error}>
                              Couldn't load this save's run
                            </span>
                          ) : run?.status === "error" ? (
                            <span className="text-signal" title={run.error ?? undefined}>
                              Regression check failed
                            </span>
                          ) : run
                            ? run.overrideReason
                              ? `override on file · "${run.overrideReason}"`
                              : run.goldenSetMissing
                                ? "no promoted reference cases at version creation"
                                : `${run.compared} reference cases compared`
                            : "no run recorded for this save"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </Table>
          </Card>

          {newestRun && newestRun.cases.length > 0 ? (
            <Card className="mb-5">
              <CardHeader>
                <div>
                  <CardTitle>
                    Case-by-case · the {steps && steps.length > 1 ? "newest hop" : "run"} (v
                    {steps?.[0]?.version.version})
                  </CardTitle>
                  <CardDescription>
                    The recorded per-case diff for this save. Click a case to open it.
                  </CardDescription>
                </div>
                <div className="flex-1" />
                <div className="flex gap-2">
                  <Chip variant="fail">{newestRun.regressed} regressed</Chip>
                  <Chip>{newestRun.improved} improved</Chip>
                  <Chip variant="outline">
                    {Math.max(0, newestRun.compared - newestRun.regressed - newestRun.improved)} unchanged
                  </Chip>
                </div>
              </CardHeader>
              <Table>
                <tbody>
                  {newestRun.cases.map((diff) => (
                    <tr
                      key={diff.caseId}
                      className={diff.change === "regress" ? "row-link row-signal" : "row-link"}
                      onClick={() => navigate(`/cases/${diff.caseId}`)}
                    >
                      <td style={{ width: 230 }}>
                        <RowLink to={`/cases/${diff.caseId}`}>
                          <Ref kind="golden" label={diff.traceId} id={diff.caseId} />
                        </RowLink>
                      </td>
                      <td
                        className="font-mono"
                        style={{
                          width: 140,
                          color: diff.change === "regress" ? "var(--signal)" : "var(--ink-3)"
                        }}
                      >
                        {diff.agreedLabel} → {diff.newLabel}
                      </td>
                      <td className="text-[12.5px] text-ink-3">{diff.rationale || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}
        </>
      ) : null}

      <Card className="max-w-[80ch] border-dashed">
        <CardContent className="py-4">
          <Eyebrow>Datasets and comparisons</Eyebrow>
          <div className="mt-2 font-serif text-[14px] leading-[1.55] tracking-[-0.005em] text-ink-2">
            Promotion and retirement advance the reference set for future evaluator versions; existing
            versions keep their original immutable corpus. Different corpus IDs therefore mean the path
            includes both evaluator and reference-set changes. For an explicit same-corpus comparison: filter{" "}
            <Link className="border-b border-ink-3 text-inherit no-underline hover:border-ink" to="/traces">
              Traces
            </Link>{" "}
            and save it as a queue — once reviewed, its verdicts are a labeled dataset you can hold
            future versions against.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function VersionPick({
  versions,
  value,
  exclude,
  onChange
}: {
  versions: SkillVersion[];
  value: string | null;
  exclude: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 cursor-pointer rounded-sm border border-rule-soft bg-card px-2 font-mono text-[11.5px] text-ink-2 hover:bg-card-2"
    >
      {versions.map((v) => (
        <option key={v.id} value={v.id} disabled={v.id === exclude}>
          v{v.version}
        </option>
      ))}
    </select>
  );
}
