import { describe, expect, it } from "vitest";
import type { DashboardSummary } from "@rubrist/shared";
import { overviewNextAction } from "../src/lib/overview-next-action.js";
const fixture = () => ({
  viewerRole: "owner", project: { mode: "bench", importedTraceCount: 250 },
  skill: { id: "skill", criterionId: "criterion", currentVersion: { id: "new", status: "approved" } },
  currentVersionResultCount: 200, exceptionsTotal: 0, exceptions: []
}) as unknown as DashboardSummary;
describe("Overview next action", () => {
  it("keeps historical backlog ahead of an unmeasured current version with full totals and exact pins", () => {
    const d = fixture(); d.currentVersionResultCount = 0; d.exceptionsTotal = 137;
    d.exceptions = Array.from({ length: 50 }, (_, i) => ({ id: `case${i}`, criterionVersionId: `old${i}` })) as DashboardSummary["exceptions"];
    const action = overviewNextAction(d, "?criterionId=criterion");
    expect(action.label).toBe("Review 50 loaded cases"); expect(action.description).toContain("137 are waiting");
    const p = new URL(action.href, "https://example.test").searchParams;
    expect(p.getAll("caseId")).toHaveLength(50); expect(p.get("criterionVersionId")).toBe("old0"); expect(p.get("cv.49")).toBe("old49");
    expect(p.get("criterionId")).toBe("criterion");
  });
  it.each([undefined, 137])("does not call an unloaded backlog clear: %s", (total) => {
    const d = fixture(); if (total === undefined) delete d.exceptionsTotal; else d.exceptionsTotal = total;
    const action = overviewNextAction(d, "?criterionId=criterion");
    expect(action.href).toBe("/exceptions?criterionId=criterion"); expect(action.description).not.toContain("No cases are waiting");
  });
  it.each(["owner", "member"] as const)("keeps the first-result route role aware for %s", (role) => {
    const d = fixture(); d.viewerRole = role; d.currentVersionResultCount = 0;
    expect(overviewNextAction(d, "?criterionId=criterion").href).toBe(role === "owner" ? "/first-result?version=new&skill=skill&criterionId=criterion" : "/datasets?criterionId=criterion");
    d.project.mode = "tracing";
    if (role === "member") expect(overviewNextAction(d, "?criterionId=criterion").href).toBe("/traces?criterionId=criterion");
  });
  it("routes an unready version to inspection, never execution", () => {
    const d = fixture(); d.skill.currentVersion.status = "draft"; d.currentVersionResultCount = 0;
    expect(overviewNextAction(d, "?criterionId=criterion").href).toBe("/skill/versions/new?criterionId=criterion");
  });
  it.each(["calibrating", "failed", "regressing", "deprecated"] as const)("does not offer execution for a known-zero backlog with a %s version", (status) => {
    const d = fixture(); d.skill.currentVersion.status = status; d.currentVersionResultCount = 0;
    for (const role of ["owner", "member"] as const) {
      d.viewerRole = role;
      expect(overviewNextAction(d, "?criterionId=criterion").href).toBe("/skill/versions/new?criterionId=criterion");
    }
  });
  it("lets a member review loaded historical evidence without inventing a missing total or carrying an old cursor", () => {
    const d = fixture(); d.viewerRole = "member"; delete d.exceptionsTotal;
    d.exceptions = [{ id: "old_case", criterionVersionId: "old_definition" }] as DashboardSummary["exceptions"];
    const action = overviewNextAction(d, "?criterionId=criterion&at=unrelated&caseId=unrelated&cv.0=unrelated");
    expect(action.label).toBe("Review 1 loaded cases");
    expect(action.description).toContain("Review backlog total unavailable");
    expect(action.description).not.toContain("No cases are waiting");
    const params = new URL(action.href, "https://example.test").searchParams;
    expect(params.getAll("caseId")).toEqual(["old_case"]);
    expect(params.get("criterionVersionId")).toBe("old_definition");
    expect(params.has("at")).toBe(false);
    expect(params.has("cv.0")).toBe(false);
  });
  it("describes an empty measured queue without an accuracy claim", () => {
    expect(overviewNextAction(fixture(), "").title).toBe("Nothing is waiting for review");
  });
});
