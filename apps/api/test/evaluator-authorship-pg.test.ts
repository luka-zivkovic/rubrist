import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { MockJudgeProvider, type JudgeProvider } from "@rubrist/audit/runtime";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/lib/auth.js";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedSkill, CapturingQueue } from "./pg-smoke-support.js";
import { SEEDED_BINDING, bindingInput } from "./fixtures/execution-binding.js";

runPgSmoke("evaluator authorship persistence", () => {
  it("preserves old version bytes on upgrade, defaults new rows honestly and rejects relabeling", async () => {
    const { pool, cleanup, databaseUrl } = await openPostgresTestDatabase("authorship_upgrade");
    const schema = `authors_${randomUUID().replaceAll("-", "")}`;
    let oldPool: Pool | undefined;
    try {
      await pool.query(`create schema "${schema}"`);
      const url = new URL(databaseUrl); url.searchParams.set("options", `-c search_path=${schema}`);
      oldPool = new Pool({ connectionString: url.toString() });
      await oldPool.query(`create table rubrist_migrations(id text primary key,checksum text not null,applied_at timestamptz not null default now())`);
      for (const id of ["0001_baseline", "0002_review_queue_evidence_pins"]) {
        const sql = await readFile(new URL(`../../../packages/db/migrations/${id}.sql`, import.meta.url), "utf8");
        await oldPool.query(sql);
        await oldPool.query(`insert into rubrist_migrations(id,checksum) values($1,$2)`, [id, createHash("sha256").update(sql).digest("hex")]);
      }
      await oldPool.query(`insert into organizations(id,name) values('org_test','Test'); insert into projects(id,organization_id,name,trace_provider) values('proj_test','org_test','Test','manual')`);
      await seedSkill(oldPool);
      const before = (await oldPool.query(`select to_jsonb(v) as row from skill_versions v where id='skillv_test'`)).rows[0].row;
      expect(before.rubric_provenance).toBe("human-authored");
      await runMigrations(oldPool); await runMigrations(oldPool);
      const after = (await oldPool.query(`select to_jsonb(v) as row from skill_versions v where id='skillv_test'`)).rows[0].row;
      expect(after).toEqual({ ...before, rubric_provenance_declared: false });
      await expect(oldPool.query(`update skill_versions set rubric_provenance='agent-drafted' where id='skillv_test'`)).rejects.toThrow("authorship is immutable");
      await expect(oldPool.query(`update skill_versions set rubric_provenance_declared=true where id='skillv_test'`)).rejects.toThrow("authorship is immutable");
      await oldPool.query(`insert into skill_versions(id,skill_id,project_id,version,status,rubric_markdown,prompt,output_schema,execution_binding,criterion_version_id)
        select 'new_version',skill_id,project_id,'0.1.1',status,rubric_markdown,prompt,output_schema,execution_binding,criterion_version_id from skill_versions where id='skillv_test'`);
      expect((await oldPool.query(`select rubric_provenance,rubric_provenance_declared from skill_versions where id='new_version'`)).rows[0]).toEqual({ rubric_provenance: "unspecified", rubric_provenance_declared: false });
    } finally { await oldPool?.end(); await pool.query(`drop schema if exists "${schema}" cascade`); await cleanup(); }
  }, 60_000);

  it.each([false, true])("keeps owner identity separate from declarations with queued=%s", async (queued) => {
    const { pool, cleanup } = await openPostgresTestDatabase("authorship_owner");
    try {
      await runMigrations(pool);
      const mock = new MockJudgeProvider();
      const provider: JudgeProvider = { name: "anthropic", modelName: "test-anthropic", judge: mock.judge.bind(mock), judgeStructured: mock.judgeStructured.bind(mock) };
      const repository = new PgRepository(pool, () => provider);
      const app = createApp(repository, { pool, auth: createAuth(pool), ...(queued ? { queue: new CapturingQueue() } : {}) });
      const post = (path: string, body: unknown, cookie = "") => app.request(path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
      const email = "authorship@example.com", password = "authorship-password";
      const setup = await post("/api/auth/setup", { email, password, name: "Owner", projectName: "Authorship", mode: "bench" });
      expect(setup.status).toBe(200);
      const { projectId } = await setup.json() as { projectId: string };
      const login = await post("/api/auth/sign-in/email", { email, password });
      expect(login.status).toBe(200);
      const cookie = String(login.headers.get("set-cookie")).split(/,(?=\s*[^;,]+=)/).map((item) => item.split(";")[0]?.trim()).filter(Boolean).join("; ");
      const starter = await repository.getLatestSkill(projectId);
      expect(starter.currentVersion).toMatchObject({ rubricProvenance: "unspecified", rubricProvenanceDeclared: false });
      const definition = { rubricMarkdown: "Pass when supported.", prompt: "Use {{rubric_markdown}}.", executionBinding: bindingInput(SEEDED_BINDING, { modelId: "test-anthropic", modelVersion: "test-anthropic-v1" }) };
      const onboarding = { idempotencyKey: "authorship-first", criterion: { name: "Support", definition: "Is this supported?" }, evaluator: { ...definition, rubricProvenance: "agent-drafted" } };
      const first = await post(`/api/skills/${starter.id}/onboarding-check`, onboarding, cookie);
      expect(first.status).toBe(queued ? 202 : 201);
      const firstBody = await first.json() as any;
      expect(firstBody.version).toMatchObject({ rubricProvenance: "agent-drafted", rubricProvenanceDeclared: true });
      expect((await post(`/api/skills/${starter.id}/onboarding-check`, onboarding, cookie)).status).toBe(queued ? 202 : 201);
      expect((await post(`/api/skills/${starter.id}/onboarding-check`, { ...onboarding, evaluator: { ...definition, rubricProvenance: "human-authored" } }, cookie)).status).toBe(409);
      for (const provenance of [undefined, "human-authored", "agent-drafted"] as const) {
        const res = await post(`/api/skills/${starter.id}/versions`, { ...definition, criterionVersionId: firstBody.criterionVersion.id, ...(provenance ? { rubricProvenance: provenance } : {}) }, cookie);
        expect(res.status).toBe(queued ? 202 : 201);
        const { version } = await res.json() as any;
        const expected = { rubricProvenance: provenance ?? "unspecified", rubricProvenanceDeclared: provenance !== undefined };
        expect(version).toMatchObject(expected);
        expect(await repository.getSkillVersion(projectId, version.id)).toMatchObject(expected);
        const row = (await pool.query(`select v.rubric_provenance,v.rubric_provenance_declared,v.created_by_user_id,v.created_by_subject_id,v.developer_identity_status,u.id as owner_id from skill_versions v join "user" u on u.email=$2 where v.id=$1`, [version.id, email])).rows[0];
        expect(row.created_by_user_id).toBe(row.owner_id);
        expect(row.created_by_subject_id).toBeTruthy();
        expect(row.developer_identity_status).toBe("recorded");
        expect(row.rubric_provenance).toBe(expected.rubricProvenance);
        expect(row.rubric_provenance_declared).toBe(expected.rubricProvenanceDeclared);
        const history = await app.request(`/api/skills/${starter.id}/versions`, { headers: { cookie } });
        expect((await history.json() as any).versions.find((v: any) => v.id === version.id)).toMatchObject(expected);
      }
    } finally { await cleanup(); }
  }, 60_000);
});
