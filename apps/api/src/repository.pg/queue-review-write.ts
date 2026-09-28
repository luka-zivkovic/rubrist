import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DatasetRevisionConflictError, type RecordVerdictInput } from "../repository.js";
import { rowToVerdictRecord } from "./mappers.js";

/** One append-only human ruling and its task completion, committed together. */
export async function recordQueueReview(client: PoolClient, input: RecordVerdictInput) {
  const context = input.reviewContext!;
  if (input.source !== "human") throw new DatasetRevisionConflictError("Only human reviews can complete a review task");
  // Use the same queue → task → run lock order as queue appends.
  await client.query(`select queue.id from review_queues queue join review_queue_items item on item.queue_id=queue.id
    where item.id=$1 and queue.project_id=$2 for update of queue`, [context.queueItemId, input.projectId]);
  const binding = await client.query(
    `select item.*, queue.status as queue_status, run.skill_version_id as reviewed_version
     from review_queue_items item
     join review_queues queue on queue.id = item.queue_id
     join judge_runs run on run.id = $4 and run.case_id = item.case_id and run.project_id = queue.project_id
     join skill_versions version on version.id = run.skill_version_id and version.criterion_version_id = item.criterion_version_id
     where item.id = $1 and queue.project_id = $2 and item.case_id = $3
       and (item.assigned_to_user_id is null or item.assigned_to_user_id = $5)
       and (item.judge_run_id is null or (item.judge_run_id = run.id and item.skill_version_id = run.skill_version_id))
       and ($6::text is null or run.skill_version_id = $6)
     for update of item, queue, run`,
    [context.queueItemId, input.projectId, input.caseId, context.judgeRunId, input.actorUserId ?? null, input.skillVersionId ?? null]
  );
  const task = binding.rows[0];
  if (!task) throw new DatasetRevisionConflictError("Review task, assignment or recorded result does not match");
  const existing = await client.query(
    `select *, (payload = $3::jsonb and actor_user_id is not distinct from $4::text
       and reviewed_judge_run_id = $5) as same_submission
     from verdicts where review_queue_item_id = $1 and review_submission_id = $2`,
    [context.queueItemId, context.submissionId, JSON.stringify(input.payload), input.actorUserId ?? null, context.judgeRunId]
  );
  if (existing.rows[0]) {
    if (!existing.rows[0].same_submission) throw new DatasetRevisionConflictError("Review submission ID already used for a different ruling");
    return rowToVerdictRecord(existing.rows[0]);
  }
  if (task.queue_status !== "open") throw new DatasetRevisionConflictError("This review queue is closed");
  const result = await client.query(
    `insert into verdicts
     (id, project_id, case_id, skill_version_id, source, actor_user_id, verdict_kind, payload,
      review_queue_item_id, reviewed_judge_run_id, review_submission_id)
     values ($1,$2,$3,$4,'human',$5,$6,$7::jsonb,$8,$9,$10) returning *`,
    [`verdict_${randomUUID()}`, input.projectId, input.caseId, task.reviewed_version,
      input.actorUserId ?? null, input.payload.kind, JSON.stringify(input.payload),
      context.queueItemId, context.judgeRunId, context.submissionId]
  );
  await client.query(
    `update review_queue_items set status = 'completed', completed_at = coalesce(completed_at, now()) where id = $1`,
    [context.queueItemId]
  );
  return rowToVerdictRecord(result.rows[0]);
}
