import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { NoCurrentSkillError } from "../src/repository/errors.js";
import { DemoRepository } from "../src/repository.js";
import type { AppVariables } from "../src/request-services/index.js";
import { registerV1AgentAdministrationRoutes } from "../src/routes/v1-agent-administration.js";

describe("v1 agent administration routes", () => {
  it("owns the exact contiguous bootstrap, read, and contract route family", () => {
    const app = new Hono<{ Variables: AppVariables }>();
    registerV1AgentAdministrationRoutes(app, {
      repository: new DemoRepository(),
      publicApiBaseUrl: () => "https://rubrist.example"
    });

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/v1/bootstrap",
      "GET /api/v1/project",
      "GET /api/v1/findings",
      "GET /api/v1/cases",
      "GET /api/v1/golden-set",
      "GET /api/v1/criteria",
      "POST /api/v1/criteria",
      "GET /api/v1/criteria/:criterionId",
      "POST /api/v1/criteria/:criterionId/versions",
      "GET /api/v1/criteria/:criterionId/current-skill",
      "GET /api/v1/evaluator-suites",
      "GET /api/v1/evaluator-suites/:suiteId",
      "GET /api/v1/evaluator-suite-manifests",
      "POST /api/v1/evaluator-suite-manifests",
      "GET /api/v1/evaluator-suite-manifests/:manifestId"
    ]);
  });
});


it("gives no-current selection an explicit code", async () => {
  class CandidateOnlyRepository extends DemoRepository {
    override async getCurrentSkillForCriterion(): Promise<never> { throw new NoCurrentSkillError("proj_demo"); }
  }
  const repository = new CandidateOnlyRepository();
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => { c.set("projectId", "proj_demo"); await next(); });
  registerV1AgentAdministrationRoutes(app, { repository, publicApiBaseUrl: () => "https://rubrist.example" });
  const response = await app.request("/api/v1/criteria/criterion_demo/current-skill");
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "no_current_evaluator" });
});
