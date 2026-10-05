import { createPgAccountServices } from "../src/accounts/postgres.js";
import { Hono } from "hono";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ProjectSettingsViewSchema } from "@rubrist/shared";
import { DemoRepository } from "../src/repository.js";
import { registerProjectAdministrationRoutes } from "../src/routes/project-administration.js";
import { bindingResolutionServices } from "../src/lib/binding-resolution.js";
import { createRequestServices, type AppVariables } from "../src/request-services/index.js";

function fixture(role: string | null, user = true, demo = false) {
  const repository = new DemoRepository();
  const dashboard = vi.spyOn(repository, "getDashboardSummary").mockRejectedValue(new Error("No evaluator selected"));
  const pool = { query: vi.fn(async () => ({ rows: role ? [{ role }] : [] })) } as unknown as Pool;
  const app = new Hono<{ Variables: AppVariables }>();
  app.use(async (c, next) => {
    c.set("projectId", "proj_langsmith_support");
    if (user) c.set("user", { id: "user_1" } as never);
    await next();
  });
  registerProjectAdministrationRoutes(app, {
    repository, ...(demo ? {} : { accounts:createPgAccountServices(pool) }),
    requestServices: createRequestServices({ repository, ownerAuthorizationEnabled: false, rateLimitPerMinute: 60, batchMaxItems: 100 }),
    publicApiBaseUrl: () => "https://rubrist.example", bindingResolution: bindingResolutionServices(async () => null)
  });
  return { app, pool, dashboard };
}

describe("project settings access metadata", () => {
  it.each(["owner", "member"])("returns %s access without selecting an evaluator", async (role) => {
    const { app, pool, dashboard } = fixture(role);
    const response = await app.request("/api/project/settings");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(ProjectSettingsViewSchema.parse(await response.json()).viewerRole).toBe(role);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("project_members"), ["user_1", "proj_langsmith_support"]);
    expect(dashboard).not.toHaveBeenCalled();
  });
  it.each([[null, true, 403], ["unexpected", true, 403], ["owner", false, 401]] as const)("fails closed for role %s and identity %s", async (role, user, status) => {
    expect((await fixture(role, user).app.request("/api/project/settings")).status).toBe(status);
  });
  it("retains mutation denial for members", async () => {
    const { app } = fixture("member");
    expect((await app.request("/api/project/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ traceRetentionDays: 30 }) })).status).toBe(403);
    expect((await app.request("/api/project/retention/prune", { method: "POST" })).status).toBe(403);
  });
  it("exposes demo access without pretending to authenticate a user", async () => {
    const { app, pool } = fixture(null, false, true);
    expect(ProjectSettingsViewSchema.parse(await (await app.request("/api/project/settings")).json()).viewerRole).toBe("owner");
    expect(pool.query).not.toHaveBeenCalled();
  });
});
