import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_TYPED_QUESTION_DRAFT,
  typedQuestionDraftFrom,
  typedQuestionDraftProblems,
  typedQuestionFromDraft
} from "../src/lib/typed-question-draft.js";

vi.mock("@/components/rubrist", () => ({ Eyebrow: ({ children }: { children?: unknown }) => createElement("span", null, children as never) }));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children?: unknown }) => createElement("section", null, children as never),
  CardContent: ({ children }: { children?: unknown }) => createElement("div", null, children as never),
  CardDescription: ({ children }: { children?: unknown }) => createElement("p", null, children as never),
  CardHeader: ({ children }: { children?: unknown }) => createElement("header", null, children as never),
  CardTitle: ({ children }: { children?: unknown }) => createElement("h2", null, children as never)
}));

const { TypedQuestionView } = await import("../src/components/typed-question-view.js");
const { TypedQuestionCard } = await import("../src/screens/skill-edit/typed-question.js");

// Typed-question authoring (ADR-0014 section 5, Batch 8F): a question, what
// makes its answer true and false, and a threshold the author must choose.

const QUESTION = { type: "noul" as const, instructions: "Does the reply answer in the user's language?", criteria: { true: "It does.", false: "It doesn't." } };
const DRAFT = { instructions: QUESTION.instructions, trueCriterion: "It does.", falseCriterion: "It doesn't.", threshold: "0.62" };

describe("the typed-question draft", () => {
  it("round-trips a saved version's question and threshold", () => {
    expect(typedQuestionDraftFrom({ typedQuestion: QUESTION, decisionThreshold: 0.62 })).toEqual(DRAFT);
    expect(typedQuestionFromDraft(DRAFT)).toEqual({ typedQuestion: QUESTION, decisionThreshold: 0.62 });
    expect(typedQuestionDraftFrom({ typedQuestion: null, decisionThreshold: null })).toEqual(EMPTY_TYPED_QUESTION_DRAFT);
  });

  it("has no default threshold, and refuses one at or outside 0 and 1", () => {
    for (const threshold of ["", " ", "0", "1", "1.5", "-0.1", "abc"]) {
      expect(typedQuestionFromDraft({ ...DRAFT, threshold }), threshold).toBeNull();
      expect(typedQuestionDraftProblems({ ...DRAFT, threshold })).toEqual(["Choose a decision threshold above 0 and below 1, on development cases."]);
    }
    expect(typedQuestionFromDraft({ ...DRAFT, threshold: "0.001" })?.decisionThreshold).toBe(0.001);
  });

  it("names each missing part of the question", () => {
    expect(typedQuestionDraftProblems(EMPTY_TYPED_QUESTION_DRAFT)).toEqual([
      "Write the question.",
      "Say what makes the answer true.",
      "Say what makes the answer false.",
      "Choose a decision threshold above 0 and below 1, on development cases."
    ]);
    expect(typedQuestionFromDraft({ ...DRAFT, falseCriterion: "  " })).toBeNull();
    expect(typedQuestionDraftProblems(DRAFT)).toEqual([]);
  });

  it("refuses text the question contract rejects, and says why", () => {
    expect(typedQuestionFromDraft({ ...DRAFT, instructions: "Is it \ud800 grounded?" })).toBeNull();
    expect(typedQuestionDraftProblems({ ...DRAFT, instructions: "Is it \ud800 grounded?" })).toEqual(["Remove the unsupported characters from the question."]);
    expect(typedQuestionDraftProblems({ ...DRAFT, falseCriterion: "No\u0000" })).toEqual(["Remove the unsupported characters from what makes the answer false."]);
    expect(typedQuestionDraftProblems({ ...DRAFT, instructions: "x".repeat(20_001) })).toEqual(["Shorten the question to 20,000 characters."]);
    expect(typedQuestionDraftProblems({ ...DRAFT, trueCriterion: "x".repeat(5_001) })).toEqual(["Shorten what makes the answer true to 5,000 characters."]);
  });

  it("reads a decimal comma as a point", () => {
    expect(typedQuestionFromDraft({ ...DRAFT, threshold: "0,62" })?.decisionThreshold).toBe(0.62);
  });
});

describe("the typed-question editor card", () => {
  it("asks for the question, both criteria, and a threshold with no default, listing what's missing", () => {
    const empty = renderToStaticMarkup(createElement(TypedQuestionCard, { draft: EMPTY_TYPED_QUESTION_DRAFT, setDraft: vi.fn() }));
    expect(empty).toContain("Typed question");
    expect(empty).toContain('placeholder="choose one"');
    expect(empty).toContain("Choose a decision threshold above 0 and below 1, on development cases.");
    expect(empty).toContain("it never abstains and states no rationale");
    const complete = renderToStaticMarkup(createElement(TypedQuestionCard, { draft: DRAFT, setDraft: vi.fn() }));
    expect(complete).not.toContain("<li>");
    expect(complete).toContain('value="0.62"');
    expect(complete).toContain('inputMode="decimal"');
    expect(complete).toContain('maxLength="20000"');
    expect(complete).not.toContain("aria-invalid");
    // Text the contract refuses marks its field invalid; the list describes every field.
    const refused = renderToStaticMarkup(createElement(TypedQuestionCard, { draft: { ...DRAFT, instructions: "x\u0000" }, setDraft: vi.fn() }));
    expect(refused).toContain('aria-invalid="true"');
    expect(refused).toContain("Remove the unsupported characters from the question.");
  });
});

describe("the typed-question view", () => {
  it("shows the question, its criteria, and the threshold that decides pass", () => {
    const html = renderToStaticMarkup(createElement(TypedQuestionView, { question: QUESTION, threshold: 0.62 }));
    expect(html).toContain("Typed question · answered by TypeSafe");
    expect(html).toContain("Does the reply answer in the user&#x27;s language?");
    expect(html).toContain("It doesn&#x27;t.");
    expect(html).toContain("pass when p ≥ 0.62");
    expect(html).toContain("it never abstains and states no rationale");
  });
});

describe("the result-type copy", () => {
  it("says a typed version passes on its threshold and never abstains", async () => {
    const { verdictKindDescription } = await import("../src/lib/verdict-kind.js");
    expect(verdictKindDescription("binary", { decisionThreshold: 0.6 }))
      .toBe("Returns pass when the model's probability that the answer is true reaches 0.6, and fail otherwise. It never abstains.");
    expect(verdictKindDescription("binary")).toContain("Use ambiguous");
  });
});
