import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { FirstRunSetupLedger } from "@/components/first-run-setup-ledger";
import { FirstProjectKeyCard } from "@/components/first-project-key";
import { FirstVerdictCard } from "@/components/first-verdict";
import { SectionHead, KPI, KPIRow, ProvBanner } from "@/components/rubrist";
import { signOffSkillVersion, ApiError } from "@/lib/api";
import { firstRunEditorPath, isBench, markSetupReceipt } from "@/lib/journey";
import type { DashboardSummary } from "@rubrist/shared";

interface DashboardProvisionalProps {
  dashboard: DashboardSummary;
  onSignedOff: () => void;
}

// Overview · first import — traces are in, but the current skill version is
// the never-approved starter draft. Every verdict is provisional until the
// rubric is reviewed (gate run) or signed off as-is (explicit approval).
export function DashboardProvisional({ dashboard, onSignedOff }: DashboardProvisionalProps) {
  const navigate = useNavigate();
  const [signingOff, setSigningOff] = useState(false);
  const [signOffError, setSignOffError] = useState<string | null>(null);

  const { project, skill, exceptions } = dashboard;
  const bench = isBench(project);
  const imported = project.importedTraceCount;
  const judged = dashboard.currentVersionResultCount;
  const withoutResult = Math.max(0, imported - judged);
  const version = skill.currentVersion;
  const owner = dashboard.viewerRole === "owner";

  async function signOffAsIs() {
    if (!window.confirm(
      `Sign off evaluator v${version.version} as-is? Existing results held for this exact version will be sent to their connected tracing provider after sign-off (normally within 30 seconds while the worker is running). This does not re-run evaluation or calibrate the evaluator. Assessments from other unsigned versions stay held.`
    )) return;
    setSigningOff(true);
    setSignOffError(null);
    try {
      await signOffSkillVersion(skill.id, version.id);
      markSetupReceipt(
        `Evaluator v${version.version} signed off. It is ready to use, but it has not been calibrated against governed human truth.`
      );
      onSignedOff();
    } catch (error) {
      setSignOffError(
        error instanceof ApiError && error.status === 403
          ? "Only owners can sign off the rubric."
          : error instanceof Error
            ? error.message
            : "Sign-off failed."
      );
    } finally {
      setSigningOff(false);
    }
  }

  return (
    <div className="fadeUp max-w-[1760px]">
      <FirstProjectKeyCard project={project} className="mb-5" />
      <div className="mb-4">
        <ProvBanner
          text={
            bench ? (
              <span>
                {judged === 0
                  ? `${imported.toLocaleString()} example${imported === 1 ? "" : "s"} ready. No complete assessment is recorded yet.`
                  : `${judged.toLocaleString()} of ${imported.toLocaleString()} examples have an assessment.`}{" "}
                Assessments remain <b>provisional</b> until an owner reviews and signs off the guide.
              </span>
            ) : (
              <span>
                {judged === 0
                  ? `No complete assessment is recorded for the ${imported.toLocaleString()} imported run${imported === 1 ? "" : "s"}.`
                  : `The starter evaluator returned an assessment for ${judged.toLocaleString()} of ${imported.toLocaleString()} runs.`}{" "}
                Recorded assessments are <b>provisional</b>. Review the guide before asking an owner to sign it off.
              </span>
            )
          }
          cta2={owner ? (
            <Button size="sm" variant="ghost" disabled={signingOff} onClick={() => void signOffAsIs()}>
              {signingOff ? "Signing off…" : "Use this starter evaluator"}
            </Button>
          ) : undefined}
          cta={
            <Button size="sm" onClick={() => navigate(owner ? firstRunEditorPath() : "/skill")}>
              {owner ? "Review the evaluator" : "View the evaluator"}
            </Button>
          }
        />
        {signOffError ? (
          <div className="mt-2 font-mono text-[11px] text-signal">{signOffError}</div>
        ) : null}
      </div>

      <SectionHead
        eyebrow={bench ? "First examples · evaluator Bench" : `First import · ${project.traceProvider}`}
        title={
          bench
            ? judged > 0
              ? `${judged.toLocaleString()} of ${imported.toLocaleString()} examples have a provisional assessment.`
              : `${imported.toLocaleString()} example${imported === 1 ? "" : "s"} ready. Run your evaluator.`
            : judged > 0
              ? `${imported.toLocaleString()} run${imported === 1 ? "" : "s"} imported. Here is what the starter evaluator found.`
              : `${imported.toLocaleString()} run${imported === 1 ? "" : "s"} imported. No complete evaluator assessment yet.`
        }
        sub={
          exceptions.length > 0
            ? `${dashboard.exceptionsTotal ?? "Some"} assessment${dashboard.exceptionsTotal === 1 ? " needs" : "s need"} a closer look. Open one to compare the recorded evidence with the starter guide.`
            : bench
              ? judged === 0
                ? "Nothing has been evaluated yet. Start one run from Examples. A supplied expected label is optional and is not governed human truth."
                : withoutResult > 0
                  ? `The evaluator did not flag the ${judged.toLocaleString()} completed example${judged === 1 ? "" : "s"}. ${withoutResult.toLocaleString()} still ${withoutResult === 1 ? "has" : "have"} no complete assessment.`
                  : `The evaluator did not flag the ${judged.toLocaleString()} example${judged === 1 ? "" : "s"} it evaluated. These assessments are still provisional.`
              : judged === 0
                ? "The runs are recorded, but this evaluator has not returned a complete assessment. It may still be running or need a retry; open cases to inspect their status."
                : withoutResult > 0
                  ? `The evaluator did not flag the ${judged.toLocaleString()} completed case${judged === 1 ? "" : "s"}. ${withoutResult.toLocaleString()} still ${withoutResult === 1 ? "has" : "have"} no complete assessment.`
                  : `The starter evaluator did not flag the ${judged.toLocaleString()} case${judged === 1 ? "" : "s"} it evaluated. These assessments are still provisional.`
        }
      />

      <FirstVerdictCard
        dashboard={dashboard}
        onOpenCase={(caseId) => navigate(`/cases/${caseId}`, { state: { backTo: "/", backLabel: "Back to overview" } })}
        className="mb-5"
      />

      <KPIRow className="mb-5">
        <KPI
          label={bench ? "Examples" : "Imported"}
          num={imported.toLocaleString()}
          foot={bench ? "supplied · no production traces" : `${project.traceProvider} · first poll`}
        />
        <KPI
          label="Assessments · provisional"
          num={judged.toLocaleString()}
          foot={`starter evaluator v${version.version}`}
        />
        <KPI
          label="Need a closer look"
          num={dashboard.exceptionsTotal ?? "—"}
          delta={exceptions.length > 0 ? "open the queue →" : "queue clear"}
          deltaKind={exceptions.length > 0 ? "signal" : "default"}
          to="/exceptions"
          src="open exceptions →"
        />
      </KPIRow>

      <div className="max-w-[960px]">
        <FirstRunSetupLedger dashboard={dashboard} />
      </div>
    </div>
  );
}
