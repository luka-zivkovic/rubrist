import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runMigrations } from "@rubrist/db";
import { PgCapabilityCheckStore, capabilityCheckContext, CAPABILITY_CHECK_CARRY_MS } from "../src/lib/capability-check-store.js";
import { runCapabilityCheck } from "../src/lib/evaluator-resolution.js";
import { SEEDED_BINDING } from "./fixtures/execution-binding.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedSkill } from "./pg-smoke-support.js";

runPgSmoke("capability check persistence", () => {
  it("upgrades the previous migration history without rewriting existing evaluator rows", async () => {
    const { pool, cleanup, databaseUrl } = await openPostgresTestDatabase("capability_upgrade");
    const schema = `carry_${randomUUID().replaceAll("-", "")}`;
    let previous: Pool | undefined;
    try {
      await pool.query(`create schema "${schema}"`);
      const url = new URL(databaseUrl); url.searchParams.set("options", `-c search_path=${schema}`);
      previous = new Pool({ connectionString: url.toString() });
      await previous.query(`create table rubrist_migrations(id text primary key,checksum text not null,applied_at timestamptz not null default now())`);
      for (const id of ["0001_baseline", "0002_review_queue_evidence_pins", "0003_evaluator_authorship"]) {
        const sql = await readFile(new URL(`../../../packages/db/migrations/${id}.sql`, import.meta.url), "utf8");
        await previous.query(sql);
        await previous.query(`insert into rubrist_migrations(id,checksum) values($1,$2)`, [id, createHash("sha256").update(sql).digest("hex")]);
      }
      await previous.query(`insert into organizations(id,name) values('org_test','Test'); insert into projects(id,organization_id,name,trace_provider) values('proj_test','org_test','Test','manual')`);
      await seedSkill(previous);
      const before = (await previous.query(`select to_jsonb(v) row from skill_versions v order by id`)).rows;
      await runMigrations(previous); await runMigrations(previous);
      expect((await previous.query(`select to_jsonb(v) row from skill_versions v order by id`)).rows).toEqual(before);
      expect((await previous.query(`select count(*) from evaluator_capability_checks`)).rows[0].count).toBe("0");
    } finally {
      await previous?.end();
      try { await pool.query(`drop schema if exists "${schema}" cascade`); }
      finally { await cleanup(); }
    }
  });
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
