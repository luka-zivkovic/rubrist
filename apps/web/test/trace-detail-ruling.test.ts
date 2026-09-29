import { createElement } from "react";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ExceptionDetail, VerdictRecord } from "@rubrist/shared";
import { TraceDetail } from "../src/components/trace-detail.js";

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: { children?: unknown }) => createElement("section", props, children as never),
  CardHeader: ({ children, ...props }: { children?: unknown }) => createElement("header", props, children as never),
  CardTitle: ({ children, ...props }: { children?: unknown }) => createElement("h2", props, children as never),
  CardDescription: ({ children, ...props }: { children?: unknown }) => createElement("p", props, children as never),
  CardContent: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never)
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never)
}));
vi.mock("@/components/ui/separator", () => ({
  Separator: (props: Record<string, unknown>) => createElement("hr", props)
}));
vi.mock("@/components/rubrist", () => ({
  Eyebrow: ({ children, ...props }: { children?: unknown }) => createElement("span", props, children as never),
  SectionHead: ({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) =>
    createElement("header", null, `${eyebrow} ${title} ${sub ?? ""}`),
  VerdictChip: ({ verdict }: { verdict: string }) => createElement("span", null, verdict),
  Chip: ({ children, ...props }: { children?: unknown }) => createElement("span", props, children as never),
  MarginNote: ({ children, ...props }: { children?: unknown }) => createElement("aside", props, children as never),
  JudgeCallPanel: () => createElement("div")
}));
vi.mock("@/lib/api", () => ({
  promoteExceptionToGoldenSet: vi.fn(),
  recordHumanVerdict: vi.fn()
}));

const humanRuling: VerdictRecord = {
  id: "verdict_human",
  projectId: "project_1",
  caseId: "case_1",
  skillVersionId: "skillv_1",
  source: "human",
  actorUserId: "user_maya",
  actorName: "Maya",
  payload: {
    kind: "categorical",
    choice: "pass",
    choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
    rationale: "The response follows the review guide."
  },
  externalRunId: null,
  createdAt: "2026-08-26T10:00:00.000Z"
};

const judgeBeforeRuling: VerdictRecord = {
  ...humanRuling,
  id: "verdict_judge_before",
  source: "llm_judge",
  actorUserId: null,
  actorName: null,
  payload: {
    kind: "categorical",
    choice: "fail",
    choiceScores: { pass: 1, fail: 0, ambiguous: 0.5 },
    rationale: "The answer omitted a direct link."
  },
  createdAt: "2026-08-26T09:00:00.000Z"
};

const detail: ExceptionDetail = {
  exception: {
    id: "case_1",
    traceId: "trace_1",
    title: "A disputed support answer",
    verdict: "fail",
    reason: "The evaluator considered the response too vague.",
    skillVersionId: "skillv_1",
    criterionVersionId: "criterionv_1",
    reviewerState: "needs_review",
    createdAt: "2026-08-26T09:00:00.000Z"
  },
  trace: {
    id: "trace_1",
    input: { question: "Can I export my data?" },
    output: { answer: "Use Workspace settings." },
    metadata: {}
  },
  judgeRun: {
    id: "judge_1",
    projectId: "project_1",
    caseId: "case_1",
    skillVersionId: "skillv_1",
    verdict: "fail",
    score: 0.2,
    reasoning: "The answer omitted a direct link.",
    createdAt: "2026-08-26T09:00:00.000Z"
  },
  datasetExpectations: [],
  latestHumanLabel: "pass",
  verdictHistory: [humanRuling, judgeBeforeRuling],
  goldenSetEntry: null
};

describe("case-detail human label state", () => {
  it("makes the durable human label primary and the assessment secondary", () => {
    const html = renderToStaticMarkup(createElement(TraceDetail, { detail }));

    expect(html).toContain("Recorded human label");
    expect(html).toContain("Ungoverned legacy review evidence");
    expect(html).toContain("not governed human truth");
    expect(html).toContain("At review time, overrode the evaluator");
    expect(html).toContain("The response follows the review guide.");
    expect(html).toContain("Maya");
    expect(html).toContain("Latest assessment");
    expect(html).toContain("overridden by human label");
    expect(html).toContain("Labeled pass");
    expect(html).toContain("Change human label");
    expect(html).toContain("Add to golden set");
    expect(html).toContain("Decision history · 2 append-only records");
    expect(html).toContain("Evaluator output");
    expect(html).not.toContain("Agree with assessment:");
    expect(html).not.toContain("next week");
  });

  it("keeps an owner human label effective over a later ordinary review", () => {
    const ownerRuling: VerdictRecord = {
      ...humanRuling,
      id: "verdict_owner",
      source: "adjudicated",
      actorUserId: "user_owner",
      actorName: "Owner Ada",
      payload: {
        ...humanRuling.payload,
        choice: "fail",
        rationale: "Owner reviewed the full case and ruled fail."
      },
      createdAt: "2026-08-26T09:30:00.000Z"
    };
    const laterReview: VerdictRecord = {
      ...humanRuling,
      id: "verdict_later",
      createdAt: "2026-08-26T11:00:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(TraceDetail, {
      detail: {
        ...detail,
        latestHumanLabel: "fail",
        verdictHistory: [laterReview, ownerRuling]
      }
    }));

    expect(html).toContain("Owner human label");
    expect(html).toContain("Owner Ada");
    expect(html).toContain("Owner reviewed the full case and ruled fail.");
    expect(html).toContain("does not override owner human label");
    expect(html).toContain("Add another review");
    expect(html).not.toContain("Change human label");
  });

  it("keeps the human label comparison pinned to the evaluator output available at review time", () => {
    const laterJudge: VerdictRecord = {
      ...judgeBeforeRuling,
      id: "verdict_judge_after",
      payload: {
        ...judgeBeforeRuling.payload,
        choice: "pass",
        rationale: "A later evaluator version accepted the answer."
      },
      createdAt: "2026-08-26T11:00:00.000Z"
    };
    const html = renderToStaticMarkup(createElement(TraceDetail, {
      detail: {
        ...detail,
        exception: { ...detail.exception, verdict: "pass" },
        judgeRun: {
          ...detail.judgeRun,
          id: "judge_2",
          verdict: "pass",
          score: 0.9,
          reasoning: "A later evaluator version accepted the answer.",
          createdAt: "2026-08-26T11:00:00.000Z"
        },
        verdictHistory: [laterJudge, humanRuling, judgeBeforeRuling]
      }
    }));

    expect(html).toContain("At review time, overrode the evaluator");
    expect(html).toContain("fail output");
    expect(html).not.toContain("At review time, agreed with the evaluator");
  });

  it("shows the active golden-set reference as a separate durable state", () => {
    const html = renderToStaticMarkup(createElement(TraceDetail, {
      detail: {
        ...detail,
        goldenSetEntry: {
          id: "gold_1",
          caseId: "case_1",
          traceId: "trace_1",
          agreedLabel: "pass",
          reason: "Protect this known-good export answer.",
          promotedBy: "Maya",
          promotedAt: "2026-08-26T12:00:00.000Z",
          sourceSkillVersionId: "skillv_1",
          criterionVersionId: "criterionv_1"
        }
      }
    }));

    expect(html).toContain("in golden set");
    expect(html).toContain("Golden-set expectation: pass");
    expect(html).toContain("Protect this known-good export answer.");
    expect(html).not.toContain("Add to golden set");
  });

  it("renders the complete claim and evidence as text, preserving raw content and escaping source markup", () => {
    const evidence = Array.from({ length: 700 }, (_, index) => `Source sentence ${index}.`);
    evidence[0] = '<script>alert("source")</script>';
    const html = renderToStaticMarkup(createElement(TraceDetail, {
      detail: { ...detail, trace: { ...detail.trace,
        input: { evidence, claim_context_for_reference_resolution_only: "Context is not evidence." },
        output: { claim: "An unsupported claim <img src=x onerror=alert(1)>" }
      } }
    }));
    expect(html).toContain("Claim to evaluate");
    expect(html).toContain("Supplied evidence · 700 entries");
    expect(html).toContain("Source sentence 699.");
    expect(html).toContain("Context is not evidence.");
    expect(html).toContain("Raw input and output");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("claim_context_for_reference_resolution_only");
  });

  it("retains the generic full payload view when extra fields might affect the evaluation", () => {
    const html = renderToStaticMarkup(createElement(TraceDetail, {
      detail: { ...detail, trace: { ...detail.trace,
        input: { evidence: ["source"], important_other_evidence: "Do not omit this." },
        output: { claim: "Claim" }
      } }
    }));
    expect(html).toContain("Case evidence");
    expect(html).toContain("Do not omit this.");
    expect(html).not.toContain("Claim to evaluate");
  });

  it("shows a recorded TypeSafe question, true probability, exact threshold and observed models without inventing an explanation", () => {
    const question = { type: "noul", instructions: "Is every claim supported?", criteria: { true: "All claims supported.", false: "Any claim unsupported." } };
    const typed: ExceptionDetail = {
      ...detail,
      judgeRun: { ...detail.judgeRun, verdict: "pass", score: 0.63, reasoning: null },
      exception: { ...detail.exception, verdict: "pass" },
      rawRequest: { provider: "typesafe", modelName: "jev-1.13.0", prompt: { id: "skillv_1", name: "0.1.4", content: JSON.stringify(question) } },
      rawResponse: { kind: "typed-question", probability: 0.63, threshold: 0.3, label: "pass", rationaleStatus: "not_provided" },
      verdictHistory: [
        { ...judgeBeforeRuling, observed: { model: "claude-sonnet-5", requestId: null, responseId: null, systemFingerprint: null, upstreamProvider: null, thinkingReturned: null, reasoningTokens: null }, skillVersionId: "skillv_sonnet" },
        { ...judgeBeforeRuling, id: "typed", payload: { kind: "binary", pass: true, rationaleStatus: "not_provided" }, observed: { model: "jev-1.13.0", requestId: null, responseId: null, systemFingerprint: null, upstreamProvider: null, thinkingReturned: null, reasoningTokens: null } }
      ]
    };
    const html = renderToStaticMarkup(createElement(TraceDetail, { detail: typed }));
    expect(html).toContain("Is every claim supported?");
    expect(html).toContain("Probability answer is true: 63%");
    expect(html).toContain("True means pass.");
    expect(html).toContain("probability is at least 0.3");
    expect(html).toContain("does not provide an explanation");
    expect(html).toContain("Model: claude-sonnet-5");
    expect(html).toContain("Model: jev-1.13.0");
    expect(html).toContain("skillv_sonnet");
    expect(html).toContain("v0.1.4");
    expect(html).not.toContain("score 0.63");
    expect(html).not.toContain("confidence");
  });

  it("escapes recorded model names and does not infer an absent model from another history item", () => {
    const html = renderToStaticMarkup(createElement(TraceDetail, {
      detail: { ...detail, verdictHistory: [{ ...judgeBeforeRuling, observed: { model: "<img src=x onerror=alert(1)>", requestId: null, responseId: null, systemFingerprint: null, upstreamProvider: null, thinkingReturned: null, reasoningTokens: null } }, { ...judgeBeforeRuling, id: "missing_model", skillVersionId: "other_version" }] }
    }));
    expect(html).toContain("Model: &lt;img");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Model: not recorded");
    expect(html).toContain("other_version");
  });

  it("refreshes the shared dashboard after standalone decisions", async () => {
    const traceSource = await readFile(new URL("../src/screens/trace.tsx", import.meta.url), "utf8");

    expect(traceSource).toMatch(/onChanged=\{\(\) => \{[\s\S]*load\(caseId\);[\s\S]*void refresh\(\);/);
  });
});


describe("review attention and progressive disclosure", () => {
  const typedDetail: ExceptionDetail = {
    ...detail,
    latestHumanLabel: null,
    verdictHistory: [judgeBeforeRuling],
    trace: { ...detail.trace, input: { evidence: ["First source sentence.", "Final source sentence."], claim_context_for_reference_resolution_only: "Reference context." }, output: { claim: "The claim to check." } },
    judgeRun: { ...detail.judgeRun, score: 0.2, reasoning: null },
    rawRequest: { provider: "typesafe", prompt: { id: "skillv_1", name: "0.1.3", content: JSON.stringify({ type: "noul", instructions: "Is every factual part supported?", criteria: { true: "All supported", false: "Unsupported" } }) } },
    rawResponse: { kind: "typed-question", probability: 0.2, threshold: 0.5, label: "fail", rationaleStatus: "not_provided" }
  };

  it("puts the opinion before long evidence, and review choices before closed diagnostics", () => {
    const html = renderToStaticMarkup(createElement(TraceDetail, { detail: typedDetail }));
    const document = new JSDOM(html).window.document;
    const disclosures = [...document.querySelectorAll("details")];
    const question = disclosures.find((el) => el.querySelector("summary")?.textContent === "Typed question and decision threshold");
    const call = disclosures.find((el) => el.querySelector("summary")?.textContent === "Judge call and version details");
    expect(question?.open).toBe(false);
    expect(call?.open).toBe(false);
    expect(question?.textContent).toContain("Is every factual part supported?");
    expect(question?.textContent).toContain("0.5");
    expect(call?.textContent).toContain("skillv_1");
    expect(html.indexOf("Latest assessment")).toBeLessThan(html.indexOf("Claim and supplied evidence"));
    expect(html.indexOf("Record your human label")).toBeLessThan(html.indexOf("Typed question and decision threshold"));
    expect(html.indexOf("Record your human label")).toBeLessThan(html.indexOf("Judge call and version details"));
    expect(html).toContain("Probability answer is true: 20%");
    expect(html).toContain("not measured accuracy");
    expect(html).toContain("does not provide an explanation");
    expect(document.querySelectorAll("ol li")).toHaveLength(2);
    expect(html).toContain("Final source sentence.");
    expect(html).toContain("Reference context.");
  });

  it("keeps a saved human label ahead of the highlighted model output", () => {
    const html = renderToStaticMarkup(createElement(TraceDetail, { detail }));
    expect(html.indexOf("Recorded human label")).toBeLessThan(html.indexOf("Latest assessment"));
    expect(html).toContain("overridden by human label");
    expect(html).not.toContain("Agree with assessment:");
  });

  it("keeps ordinary LLM rationale visible without a typed-question disclosure", () => {
    const html = renderToStaticMarkup(createElement(TraceDetail, { detail: { ...detail, verdictHistory: [], latestHumanLabel: null } }));
    const document = new JSDOM(html).window.document;
    const rationale = [...document.querySelectorAll("div")].find((el) => el.textContent === "The answer omitted a direct link.");
    expect(rationale).toBeDefined();
    expect(rationale?.closest("details")).toBeNull();
    expect(html).not.toContain("Typed question and decision threshold");
  });
});
