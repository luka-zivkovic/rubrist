import type { DashboardSummary } from "@rubrist/shared";
import { currentCheckIsReady, firstResultPath, isBench } from "./journey.js";
import { queueReviewUrl } from "./exception-queue.js";
import { contextualHref } from "./route-metadata.js";

// Operational next step only: these counters do not establish governed truth
// or evaluator validity. Historical waiting cases take precedence over a new
// version's first result because they already have evidence to review.
export function overviewNextAction(dashboard: DashboardSummary, search: string) {
  const { exceptions, exceptionsTotal, skill } = dashboard;
  const href = (path: string) => contextualHref(path, search);
  const count = exceptionsTotal === undefined ? "Review backlog total unavailable" : `${exceptionsTotal} ${exceptionsTotal === 1 ? "is" : "are"} waiting on a person`;
  if (exceptions.length) return {
    title: "Review the waiting cases",
    description: `${count}. Start with the ${exceptions.length} loaded cases; return to the queue for the next batch.`,
    label: `Review ${exceptions.length} loaded cases`, href: queueReviewUrl(exceptions, search)
  };
  if (exceptionsTotal === undefined || exceptionsTotal > 0) return {
    title: "Check the review queue", description: `${count}. No waiting cases are loaded in this preview.`,
    label: "Open queue", href: href("/exceptions")
  };
  if (!currentCheckIsReady(dashboard)) return {
    title: "Review the current Check", description: "No cases are waiting for review. Inspect the current version and its recorded status before starting another Result.",
    label: "View Check", href: href(`/skill/versions/${encodeURIComponent(skill.currentVersion.id)}`)
  };
  if (dashboard.currentVersionResultCount === 0) {
    const owner = dashboard.viewerRole === "owner";
    const bench = isBench(dashboard.project);
    return {
      title: "See this Check's first Result",
      description: owner ? "No cases are waiting for review, and this version has no recorded Result yet." : "No cases are waiting for review. An owner needs to start the first Result for this version.",
      label: owner ? "Continue to first Result" : bench ? "Open examples" : "Open traces",
      href: owner ? firstResultPath(skill.currentVersion.id, skill.id, skill.criterionId) : href(bench ? "/datasets" : "/traces")
    };
  }
  return {
    title: "Nothing is waiting for review", description: "Saved rulings remain on their cases. You can inspect protected examples or the recorded results below.",
    label: "Open protected examples", href: href("/golden")
  };
}
