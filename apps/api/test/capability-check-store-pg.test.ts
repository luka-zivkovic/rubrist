import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { PgCapabilityCheckStore, capabilityCheckContext, CAPABILITY_CHECK_CARRY_MS } from "../src/lib/capability-check-store.js";
import { runCapabilityCheck } from "../src/lib/evaluator-resolution.js";
import { SEEDED_BINDING } from "./fixtures/execution-binding.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedSkill } from "./pg-smoke-support.js";

runPgSmoke("capability check persistence", () => {
  it("survives another store instance, expires, isolates projects/keys and preserves existing evidence on repeat migrations", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("capability_carry");
    try {
      await runMigrations(pool);
      await pool.query(`insert into organizations(id,name) values('org_test','Test');
        insert into projects(id,organization_id,name,trace_provider) values('proj_test','org_test','Test','manual')`);
      await seedSkill(pool);
      const before = (await pool.query(`select to_jsonb(v) row from skill_versions v where id='skillv_test'`)).rows[0].row;
      await runMigrations(pool);
      expect((await pool.query(`select to_jsonb(v) row from skill_versions v where id='skillv_test'`)).rows[0].row).toEqual(before);
      const { provider, endpoint, modelId, modelVersion, outputTokenLimit, routing } = SEEDED_BINDING;
      const check = await runCapabilityCheck({ base: { provider, endpoint, modelId, modelVersion, outputTokenLimit, routing },
        credentialSource: "project", published: null, documentedDefault: null, temperatureIgnored: false,
        execute: async () => ({ usage: null }) });
      const contextDigest = capabilityCheckContext(check, "private-test-key");
      const now = new Date("2026-09-29T10:00:00Z");
      const writer = new PgCapabilityCheckStore(pool);
      await writer.put({ projectId: "proj_test", contextDigest, checkedAt: now, classification: false, check });
      const reader = new PgCapabilityCheckStore(pool);
      expect(await reader.get("proj_test", contextDigest, now, SEEDED_BINDING)).toMatchObject({ base: check.base });
      expect(await reader.get("other", contextDigest, now, SEEDED_BINDING)).toBeNull();
      expect(await reader.get("proj_test", capabilityCheckContext(check, "rotated"), now, SEEDED_BINDING)).toBeNull();
      expect(await reader.get("proj_test", contextDigest, new Date(now.getTime() + CAPABILITY_CHECK_CARRY_MS), SEEDED_BINDING)).toBeNull();
      expect(JSON.stringify((await pool.query(`select * from evaluator_capability_checks`)).rows)).not.toContain("private-test-key");
      const next = new Date(now.getTime() + CAPABILITY_CHECK_CARRY_MS);
      await writer.put({ projectId: "proj_test", contextDigest, checkedAt: next, classification: false, check });
      expect((await pool.query(`select count(*) from evaluator_capability_checks`)).rows[0].count).toBe("1");
    } finally { await cleanup(); }
  });
});
