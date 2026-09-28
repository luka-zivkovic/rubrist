import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import { PgRepository } from "../src/repository.pg.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";
import { runPgSmoke, seedSkill, waitFor } from "./pg-smoke-support.js";

runPgSmoke("saved review evidence pins", () => {
  it("pins a recorded result, isolates completion, handles retries and preserves append-only corrections", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("review_pins");
    try {
      await runMigrations(pool);
      const repo = new PgRepository(pool);
      await pool.query(`insert into organizations (id,name) values ('org_test','Test')`);
      await pool.query(`insert into projects (id,organization_id,name,trace_provider) values ('proj_test','org_test','Test','manual')`);
      await seedSkill(pool);
      await pool.query(`insert into skill_versions (id,skill_id,project_id,version,status,rubric_markdown,prompt,output_schema,execution_binding,criterion_version_id)
        select 'skillv_other',skill_id,project_id,'0.2.0',status,rubric_markdown,prompt,output_schema,execution_binding,criterion_version_id from skill_versions where id='skillv_test'`);
      const { caseId } = await repo.importTrace("proj_test", "manual", { sourceTraceId: "review-pin", input: "evidence", output: "claim", metadata: {} }, { ingestionPurpose: "analysis_eligible_manual" });
      const run = await repo.recordJudgeRun({ projectId: "proj_test", caseId, skillVersionId: "skillv_test", verdict: { label: "fail", score: 0.1, confidence: 0.9, reason: "Missing evidence" } });
      const queue = await repo.createReviewQueue({ projectId: "proj_test", name: "Pinned", caseIds: [caseId], skillVersionId: "skillv_test" });
      const item = (await repo.getReviewQueueDetail("proj_test", queue.id))!.items[0]!;
      expect(item).toMatchObject({ skillVersionId: "skillv_test", judgeRunId: run.id, criterionVersionId: "criterionv_test" });
      // Ordinary writer deduplicates case/version; explicitly model another recorded run.
      const sameModelAgain = { id: `judge_${randomUUID()}` };
      await pool.query(`insert into judge_runs(id,project_id,case_id,skill_version_id,verdict,score,reasoning,created_at)
        values($1,'proj_test',$2,'skillv_test','pass',0.9,'Later run',now()+interval '1 second')`, [sameModelAgain.id,caseId]);
      const otherRun = await repo.recordJudgeRun({ projectId: "proj_test", caseId, skillVersionId: "skillv_other", verdict: { label: "pass", score: 0.9, confidence: 0.9, reason: "Another evaluator" } });
      const otherQueue = await repo.createReviewQueue({ projectId: "proj_test", name: "Other", caseIds: [caseId], skillVersionId: "skillv_other" });
      const extra = await repo.addReviewQueueItems({ projectId: "proj_test", queueId: queue.id, items: [{ caseId, skillVersionId: "skillv_test" }] });
      expect(extra).toHaveLength(1);
      expect(extra[0]!.judgeRunId).toBe(sameModelAgain.id);
      expect((await repo.getCaseDetail("proj_test", caseId, item.skillVersionId!, item.criterionVersionId, item.judgeRunId!))?.judgeRun.id).toBe(run.id);
      expect(await repo.getCaseDetail("proj_test", caseId, "skillv_other", item.criterionVersionId, run.id)).toBeNull();
      expect(await repo.getCaseDetail("wrong_project", caseId, undefined, undefined, run.id)).toBeNull();
      expect(await repo.getCaseDetail("proj_test", caseId, undefined, undefined, "missing_run")).toBeNull();
      const input = { projectId: "proj_test", caseId, source: "human" as const, payload: { kind: "binary" as const, pass: false, rationale: "Human evidence" }, reviewContext: { queueItemId: item.id, judgeRunId: run.id, submissionId: randomUUID() } };
      await expect(repo.recordVerdict({ ...input, reviewContext: { ...input.reviewContext, judgeRunId: otherRun.id } })).rejects.toThrow(/does not match/);
      await expect(repo.recordVerdict({ ...input, skillVersionId: "skillv_other" })).rejects.toThrow(/does not match/);
      await repo.recordVerdict({ projectId: "proj_test", caseId, source: "human", skillVersionId: "skillv_test", payload: input.payload });
      expect((await repo.getReviewQueueDetail("proj_test", queue.id))!.queue.pendingCount).toBe(2);
      const [first, retry] = await Promise.all([repo.recordVerdict(input), repo.recordVerdict(input)]);
      expect(first.id).toBe(retry.id);
      expect(first.skillVersionId).toBe("skillv_test");
      expect(first.reviewContext).toEqual(input.reviewContext);
      expect((await repo.getReviewQueueDetail("proj_test", queue.id))!.queue).toMatchObject({ pendingCount: 1, completedCount: 1 });
      expect((await repo.getReviewQueueDetail("proj_test", otherQueue.id))!.queue.pendingCount).toBe(1);
      await expect(repo.recordVerdict({ ...input, payload: { ...input.payload, pass: true } })).rejects.toThrow(/already used/);
      const correction = await repo.recordVerdict({ ...input, payload: { ...input.payload, pass: true }, reviewContext: { ...input.reviewContext, submissionId: randomUUID() } });
      expect(correction.id).not.toBe(first.id);
      expect((await repo.getCaseDetail("proj_test", caseId, undefined, undefined, run.id))!.verdictHistory.filter((v) => v.reviewContext?.queueItemId === item.id)).toHaveLength(2);
      await expect(pool.query(`update review_queue_items set judge_run_id=$1 where id=$2`, [sameModelAgain.id,item.id])).rejects.toThrow(/immutable/);
      await expect(pool.query(`update judge_runs set reasoning='changed' where id=$1`, [run.id])).rejects.toThrow(/immutable/);
      await expect(pool.query(`delete from judge_runs where id=$1`, [run.id])).rejects.toThrow();
      await expect(pool.query(`update verdicts set payload=payload where id=$1`, [first.id])).rejects.toThrow(/append-only/);
      await expect(pool.query(`delete from review_queues where id=$1`,[otherQueue.id])).rejects.toThrow(/cannot be deleted/);
      await expect(pool.query(`update review_queues set project_id='wrong' where id=$1`,[queue.id])).rejects.toThrow(/immutable/);
      await repo.closeReviewQueue("proj_test", queue.id);
      await expect(repo.recordVerdict({ ...input, reviewContext: { ...input.reviewContext, submissionId: randomUUID() } })).rejects.toThrow(/closed/);
      expect((await repo.recordVerdict(input)).id).toBe(first.id);
      await pool.query(`delete from projects where id='proj_test'`);
      expect((await pool.query(`select count(*)::int as count from verdicts where review_queue_item_id=$1`,[item.id])).rows[0].count).toBe(0);
    } finally { await cleanup(); }
  }, 60_000);

  it("serializes append/review, rolls back failed completion, preserves account erasure and locks first-view evidence", async () => {
    const { pool, cleanup } = await openPostgresTestDatabase("review_pin_races");
    try {
      await runMigrations(pool);
      await pool.query(`insert into organizations(id,name) values('org_test','Test');
        insert into projects(id,organization_id,name,trace_provider) values('proj_test','org_test','Test','manual');
        insert into "user"(id,name,email) values('reviewer_a','A','a@review.test'),('reviewer_b','B','b@review.test')`);
      await seedSkill(pool);
      const repo = new PgRepository(pool);
      const { caseId } = await repo.importTrace("proj_test","manual",{ sourceTraceId: "race",input:"Evidence",output:"Claim",metadata:{} },{ ingestionPurpose:"analysis_eligible_manual" });
      const run = await repo.recordJudgeRun({ projectId:"proj_test",caseId,skillVersionId:"skillv_test",verdict:{ label:"fail",score:0.1,confidence:0.9,reason:"Original" } });
      const queue = await repo.createReviewQueue({ projectId:"proj_test",name:"Race",caseIds:[caseId],skillVersionId:"skillv_test" });
      const first = (await repo.getReviewQueueDetail("proj_test",queue.id))!.items[0]!;
      const input = { projectId:"proj_test",caseId,source:"human" as const,actorUserId:"reviewer_a",payload:{kind:"binary" as const,pass:false,rationale:"Evidence"},reviewContext:{ queueItemId:first.id,judgeRunId:run.id,submissionId:randomUUID() } };
      const [addedA, addedB] = await Promise.all([
        repo.addReviewQueueItems({ projectId:"proj_test",queueId:queue.id,items:[{caseId,skillVersionId:"skillv_test",assignedToUserId:"reviewer_a"}] }),
        repo.addReviewQueueItems({ projectId:"proj_test",queueId:queue.id,items:[{caseId,skillVersionId:"skillv_test",assignedToUserId:"reviewer_b"}] }),
        repo.recordVerdict(input)
      ]);
      expect(new Set([addedA[0]!.position,addedB[0]!.position]).size).toBe(2);
      const assigned = {...input,reviewContext:{...input.reviewContext,queueItemId:addedA[0]!.id,submissionId:randomUUID()} };
      await expect(repo.recordVerdict({...assigned,actorUserId:"reviewer_b"})).rejects.toThrow(/does not match/);
      await pool.query(`create function reject_review_completion() returns trigger language plpgsql as $$ begin raise exception 'injected completion failure'; end $$;
        create trigger test_reject_completion before update of status on review_queue_items for each row execute function reject_review_completion()`);
      await expect(repo.recordVerdict(assigned)).rejects.toThrow(/injected completion failure/);
      expect((await pool.query(`select count(*)::int as count from verdicts where review_submission_id=$1`,[assigned.reviewContext.submissionId])).rows[0].count).toBe(0);
      expect((await repo.getReviewQueueDetail("proj_test",queue.id))!.items.find((i)=>i.id===addedA[0]!.id)!.status).toBe("pending");
      await pool.query(`drop trigger test_reject_completion on review_queue_items`);
      const saved = await repo.recordVerdict(assigned);
      await expect(pool.query(`update review_queue_items set assigned_to_user_id='reviewer_b' where id=$1`,[addedA[0]!.id])).rejects.toThrow(/immutable/);
      await pool.query(`delete from "user" where id='reviewer_a'`);
      expect((await pool.query(`select actor_user_id from verdicts where id=$1`,[saved.id])).rows[0].actor_user_id).toBeNull();
      expect((await repo.getReviewQueueDetail("proj_test",queue.id))!.items.find((i)=>i.id===addedA[0]!.id)).toMatchObject({ status:"completed",assignedToUserId:null });
      await pool.query(`delete from "user" where id='reviewer_b'`);
      expect((await repo.getReviewQueueDetail("proj_test",queue.id))!.items.find((i)=>i.id===addedB[0]!.id)).toMatchObject({status:"pending",assignedToUserId:null});
      await repo.recordVerdict({...input,actorUserId:undefined,reviewContext:{...input.reviewContext,queueItemId:addedB[0]!.id,submissionId:randomUUID()}});
      expect((await repo.getReviewQueueDetail("proj_test",queue.id))!.items.find((i)=>i.id===addedB[0]!.id)!.status).toBe("completed");
      // A first pin holds the source run against updates until commit; the
      // blocked updater must then observe the pin and reject its mutation.
      const raceRun = `judge_${randomUUID()}`;
      await pool.query(`insert into judge_runs(id,project_id,case_id,skill_version_id,verdict,score,reasoning) values($1,'proj_test',$2,'skillv_test','fail',0.1,'Frozen')`,[raceRun,caseId]);
      const writer = await pool.connect();
      try {
        await writer.query('begin');
        await writer.query(`insert into review_queue_items(id,queue_id,case_id,criterion_version_id,position,skill_version_id,judge_run_id)
          values('race_task',$1,$2,'criterionv_test',3,'skillv_test',$3)`,[queue.id,caseId,raceRun]);
        const mutation = pool.query(`update judge_runs set reasoning='raced' where id=$1`,[raceRun]);
        const rejection = expect(mutation).rejects.toThrow(/immutable/);
        await waitFor(async()=> Number((await pool.query(`select count(*) as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'update judge_runs set reasoning=%'`)).rows[0].n)>0, 5000);
        await writer.query('commit');
        await rejection;
      } finally { await writer.query('rollback'); writer.release(); }
      expect((await pool.query(`select reasoning from judge_runs where id=$1`,[raceRun])).rows[0].reasoning).toBe("Frozen");
    } finally { await cleanup(); }
  }, 60_000);

  it("upgrades the existing baseline without rewriting existing reviews, and retries harmlessly", async () => {
    const { pool, cleanup, databaseUrl } = await openPostgresTestDatabase("review_pin_upgrade");
    const upgradeSchema = `review_upgrade_${randomUUID().replaceAll("-", "")}`;
    try {
      // Separate schema creates a true pre-0002 installation even with template cloning.
      await pool.query(`create schema "${upgradeSchema}"`);
      const url = new URL(databaseUrl); url.searchParams.set("options", `-c search_path=${upgradeSchema}`);
      const oldPool = new Pool({ connectionString: url.toString() });
      const client = await oldPool.connect();
      try {
        await client.query(`set search_path="${upgradeSchema}"`);
        const baseline = await readFile(new URL("../../../packages/db/migrations/0001_baseline.sql", import.meta.url), "utf8");

        await client.query(baseline);
        await client.query(`insert into organizations(id,name) values('org_test','Test'); insert into projects(id,organization_id,name,trace_provider) values('proj_test','org_test','Test','manual')`);
        await seedSkill(client as never);
        await client.query(`insert into cases(id,project_id,case_type,ingestion_purpose,normalized_payload) values('old_case','proj_test','release_evidence','release_evidence','{}')`);
        await client.query(`insert into review_queues(id,project_id,name) values('old_queue','proj_test','Original');
          insert into review_queue_items(id,queue_id,case_id,criterion_version_id,position,status,completed_at) values('old_item','old_queue','old_case','criterionv_test',0,'completed',now());
          insert into verdicts(id,project_id,case_id,skill_version_id,source,verdict_kind,payload) values('old_human','proj_test','old_case','skillv_test','human','binary','{"kind":"binary","pass":true,"rationale":"Original person"}')`);
        const before = (await client.query(`select to_jsonb(v) as row from verdicts v where id='old_human'`)).rows[0].row;
        const itemBefore = (await client.query(`select to_jsonb(i) as row from review_queue_items i where id='old_item'`)).rows[0].row;
        await client.query(`create table rubrist_migrations(id text primary key,checksum text,applied_at timestamptz not null default now())`);
        await client.query(`insert into rubrist_migrations(id,checksum) values('0001_baseline',$1)`,[createHash("sha256").update(baseline).digest("hex")]);
        await runMigrations(oldPool);
        await runMigrations(oldPool);
        expect((await client.query(`select to_jsonb(v)-'review_queue_item_id'-'reviewed_judge_run_id'-'review_submission_id' as row from verdicts v where id='old_human'`)).rows[0].row).toEqual(before);
        expect((await client.query(`select to_jsonb(i)-'skill_version_id'-'judge_run_id'-'assignment_key' as row from review_queue_items i where id='old_item'`)).rows[0].row).toEqual(itemBefore);
        expect((await client.query(`select judge_run_id,skill_version_id from review_queue_items where id='old_item'`)).rows[0]).toEqual({ judge_run_id: null, skill_version_id: null });
        expect(createHash("sha256").update(baseline).digest("hex")).toBe("ad6cc2bd761ed324fead34d8db59a50d0d2ed21a6ae17223ad7eee40c608ae83");
      } finally { await client.query(`set search_path=public`); client.release(); await oldPool.end(); }
      await runMigrations(pool);
      await runMigrations(pool);
    } finally { await pool.query(`drop schema if exists "${upgradeSchema}" cascade`); await cleanup(); }
  }, 60_000);
});
