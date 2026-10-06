import type { AccountServices } from "../src/accounts/ports.js";
import { createPgAccountServices } from "../src/accounts/postgres.js";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { RubristAuth } from "../src/lib/auth.js";

const fakeAuth = {
  api: { getSession: async () => null },
  handler: async () => new Response(null, { status: 404 })
} as unknown as RubristAuth;

function routeManifest(options: { auth?: RubristAuth; pool?: Pool; accounts?: AccountServices } = {}): string[] {
  const app = createApp(undefined, options);
  return app.routes.map(({ method, path }) => `${method} ${path}`);
}

describe("app route registration contract", () => {
  it("rejects oversized manual evidence before importing any cases", async () => {
    const { DemoRepository } = await import("../src/repository.js");
    const repository = new DemoRepository();
    const imported = vi.spyOn(repository, "importTrace");
    const response = await createApp(repository).request("/api/traces/manual", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceTraceId: "too-big", input: "x".repeat(256 * 1024 + 1), output: "answer" })
    });
    expect(response.status).toBe(413);
    expect(imported).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins readable demo and auth-enabled route manifests", () => {
    const demo = routeManifest();
    const authenticated = routeManifest({ auth: fakeAuth, accounts:createPgAccountServices({} as Pool) });
    const authenticatedWithPool = routeManifest({ auth: fakeAuth, pool: {} as Pool });

    expect(demo).toHaveLength(245);
    // This snapshot intentionally follows Hono's route registry. A Hono upgrade
    // must show reviewers the complete ordered route-table diff, not a new hash.
    expect(demo).toMatchSnapshot("demo route manifest");
    expect(authenticated).toHaveLength(247);
    expect(authenticated).toMatchSnapshot("authenticated route manifest");
    // Legacy PG composition and injected accounts register the same routes.
    // Real auth behavior is characterized in pg-auth.test.ts.
    expect(authenticatedWithPool).toEqual(authenticated);
  });

  it("keeps public routes, body limits, auth, and project resolution in fail-closed order", () => {
    const routes = routeManifest({ auth: fakeAuth, accounts:createPgAccountServices({} as Pool) });
    expect(routes.slice(0, 19)).toEqual([
      "ALL /*",
      "ALL /*",
      "GET /health",
      "GET /ready",
      "ALL /*",
      "GET /api/auth/setup-required",
      "POST /api/auth/setup",
      "POST /api/auth/redeem-invite",
      "ALL /api/auth/sign-up/email",
      "POST /api/auth/*",
      "GET /api/auth/*",
      "ALL /api/v1/*",
      "ALL /api/datasets/:datasetId/examples",
      "ALL /api/traces/manual",
      "ALL /api/trace-tests",
      "ALL /api/trace-tests/*",
      "ALL /api/v1/*",
      "ALL /api/*",
      "ALL /api/governed-review/*"
    ]);
    expect(routes.filter((route) => route === "ALL /api/v1/*")).toHaveLength(2);
  });

  it("rejects an oversized v1 body before checking for an API key", async () => {
    vi.stubEnv("JUDGE_MAX_BODY_BYTES", "1024");
    vi.resetModules();
    const { createApp: createAppWithPinnedLimit } = await import("../src/app.js");
    const app = createAppWithPinnedLimit(undefined, { auth: fakeAuth, accounts:createPgAccountServices({} as Pool) });
    const response = await app.request("/api/v1/judge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1025)
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: "Request body exceeds 1024 bytes"
    });
  });
});
