import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { vi } from "vitest";
import { CreateSkillVersionInputSchema, EvaluatorCandidateCreateInputSchema, evaluatorAuthorship } from "@rubrist/shared";
import { DemoRepository } from "../src/repository.js";
import { registerSkillAdministrationRoutes } from "../src/routes/skill-administration.js";
import { createRequestServices, type AppVariables } from "../src/request-services/index.js";
import { evaluatorIdentityFor } from "../src/lib/evaluator-identity.js";
import { MOCK_BINDING, bindingInput } from "./fixtures/execution-binding.js";

const input = { rubricMarkdown: "Pass when supported.", prompt: "Use {{rubric_markdown}}.", executionBinding: bindingInput(MOCK_BINDING) };

describe("evaluator authorship", () => {
  it.each([undefined, "unspecified", "human-authored", "agent-drafted"] as const)("records %s without inferring it from the saving account, inline and queued", async (provenance) => {
    for (const queued of [false, true]) {
      const repository = new DemoRepository();
      const create = vi.spyOn(repository, queued ? "createSkillVersionPending" : "createSkillVersion");
      const app = new Hono<{ Variables: AppVariables }>();
      const skill = await repository.getCurrentSkill();
      app.use("*", async (c, next) => {
        c.set("projectId", skill.projectId);
        c.set("user", { id: "saving-owner" } as AppVariables["user"]);
        await next();
      });
      registerSkillAdministrationRoutes(app, {
        repository,
        requestServices: createRequestServices({ repository, ownerAuthorizationEnabled: false, rateLimitPerMinute: 60, batchMaxItems: 100 }),
        ...(queued ? { queue: { send: async () => "job" } as any } : {})
      });
      const res = await app.request(`/api/skills/${skill.id}/versions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, ...(provenance ? { rubricProvenance: provenance } : {}) }) });
      expect(res.status).toBe(queued ? 202 : 201);
      const { version } = await res.json() as any;
      const expected = { rubricProvenance: provenance ?? "unspecified", rubricProvenanceDeclared: Boolean(provenance && provenance !== "unspecified") };
      expect(version).toMatchObject(expected);
      expect(create.mock.calls[0]?.[2]).toMatchObject({ actorUserId: "saving-owner" });
      const history = await (await app.request(`/api/skills/${skill.id}/versions`)).json() as any;
      expect(history.versions.find((v: any) => v.id === version.id)).toMatchObject(expected);
      const card = await (await app.request(`/api/skills/${skill.id}/versions/${version.id}/card`)).json() as any;
      expect(card.version).toMatchObject(expected);
    }
  });

  it("gives a dedicated agent declaration precedence and leaves execution identity unchanged", async () => {
    const repo = new DemoRepository();
    const skill = await repo.getCurrentSkill();
    const version = await repo.createSkillVersionPending(skill.id, CreateSkillVersionInputSchema.parse({ ...input, rubricProvenance: "human-authored" }), { projectId: skill.projectId, rubricProvenance: "agent-drafted" });
    expect(version).toMatchObject({ rubricProvenance: "agent-drafted", rubricProvenanceDeclared: true });
    const changed = { ...version, rubricProvenance: "unspecified" as const, rubricProvenanceDeclared: false };
    expect(evaluatorIdentityFor(version)).toEqual(evaluatorIdentityFor(changed));
  });

  it("keeps omitted input omitted for existing idempotency digests and validates governed declarations", () => {
    expect(CreateSkillVersionInputSchema.parse(input)).not.toHaveProperty("rubricProvenance");
    const candidate = { ...input, criterionId: "c", criterionVersionId: "cv", governedBatchId: "b", expectedBatchDigest: `sha256:${"a".repeat(64)}`, truthDatasetRevisionId: "d", expectedTruthRevisionDigest: `sha256:${"b".repeat(64)}`, expectedTruthContentDigest: `sha256:${"c".repeat(64)}`, skillName: "Support", skillDescription: "Support", idempotencyKey: "key" };
    expect(EvaluatorCandidateCreateInputSchema.parse(candidate)).not.toHaveProperty("rubricProvenance");
    expect(EvaluatorCandidateCreateInputSchema.parse({ ...candidate, rubricProvenance: "agent-drafted" })).toHaveProperty("rubricProvenance", "agent-drafted");
    expect(EvaluatorCandidateCreateInputSchema.safeParse({ ...candidate, rubricProvenance: "approved" }).success).toBe(false);
  });

  it("distinguishes historical metadata, explicit declarations and missing authorship", () => {
    expect(evaluatorAuthorship({ rubricProvenance: "human-authored" }).label).toBe("Previously recorded: Human-authored");
    expect(evaluatorAuthorship({ rubricProvenance: "agent-drafted", rubricProvenanceDeclared: true }).label).toBe("Declared: Agent-drafted or assisted");
    expect(evaluatorAuthorship({ rubricProvenance: "unspecified" }).label).toBe("Not specified");
  });
});
