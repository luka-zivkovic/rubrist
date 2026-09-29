import { useNavigate } from "react-router-dom";
import { SetupLedger } from "@/components/rubrist";
import { firstResultPath, firstRunEditorPath, firstRunSetupStepStates, isBench } from "@/lib/journey";
import type { DashboardSummary } from "@rubrist/shared";

export function FirstRunSetupLedger({
  dashboard,
  className
}: {
  dashboard: DashboardSummary;
  className?: string;
}) {
  const navigate = useNavigate();
  const { project, skill } = dashboard;
  const bench = isBench(project);
  const states = firstRunSetupStepStates(dashboard);
  const done = Object.values(states).filter((state) => state === "done").length;
  const imported = project.importedTraceCount;
  const judged = dashboard.currentVersionResultCount;
  const owner = dashboard.viewerRole === "owner";
  const editPath = owner ? skill.isStarter ? firstRunEditorPath() : "/skill/edit" : "/skill";

  return (
    <SetupLedger
      {...(className ? { className } : {})}
      title="Get your first result"
      description={done === 3 ? "3 of 3 complete · first result ready" : `${done} of 3 complete · based on saved project state`}
      steps={[
        {
          state: states.bringRun,
          title: bench ? "Bring one example run" : "Bring one recorded run",
          ...(states.bringRun === "done"
            ? { foot: `${imported.toLocaleString()} ${bench ? "example" : "run"}${imported === 1 ? "" : "s"}` }
            : {
                detail: bench
                  ? "A run is one input and the output your AI produced. An expected result is optional."
                  : "Connect LangSmith or Langfuse, or paste one run. Rubrist reads the record; it does not replay your AI.",
                cta: bench ? "Add an example" : "Add a recorded run",
                onCta: () => navigate(bench ? "/datasets?add=1" : "/traces"),
                secondaryCta: owner ? "Set up without a run" : "View evaluator",
                onSecondaryCta: () => navigate(editPath)
              })
        },
        {
          state: states.chooseCheck,
          title: "Choose one criterion to evaluate",
          ...(states.chooseCheck === "done"
            ? { foot: `Evaluator v${skill.currentVersion.version} ready` }
            : {
                detail: owner
                  ? "Tell Rubrist one quality that matters. Technical settings stay out of the first-run path."
                  : "An owner needs to choose the project's first evaluator. You can still inspect the current starter.",
                ...(states.chooseCheck === "now" && owner
                  ? { cta: "Review the evaluator", onCta: () => navigate(editPath) }
                  : states.chooseCheck === "now"
                    ? { foot: "Waiting for an owner" }
                    : {})
              })
        },
        {
          state: states.seeResult,
          title: "See the first assessment",
          ...(states.seeResult === "done"
            ? { foot: `${judged.toLocaleString()} result${judged === 1 ? "" : "s"}` }
            : {
                detail: "Rubrist applies the evaluator to recorded evidence. This is the evaluator's opinion until a person reviews it separately.",
                ...(states.seeResult === "now"
                  ? dashboard.viewerRole === "owner" ? {
                      cta: "Continue to first assessment",
                      onCta: () => navigate(firstResultPath(skill.currentVersion.id, skill.id, skill.criterionId))
                    } : { foot: "An owner needs to start this assessment." }
                  : {})
              })
        }
      ]}
    />
  );
}
