import { randomUUID } from "node:crypto";
import type {
  ReviewQueue,
  ReviewQueueDetail,
  ReviewQueueItem,
  ReviewQueueStatus,
  Skill
} from "@rubrist/shared";
import type { Pool } from "pg";
import {
  AmbiguousProjectSkillError,
  DatasetRevisionConflictError,
  type AddQueueItemsInputDb,
  type CreateReviewQueueInputDb
} from "../repository.js";
import type { ReviewQueueRepositoryPort } from "../repository/ports.js";
import {
  rowToReviewQueue,
  rowToReviewQueueItem
} from "./mappers.js";

// PostgreSQL persistence for owner-curated ungoverned review queues. This slice
// schedules explicit human attention; it does not make release decisions.
export class PgReviewQueueRepository implements ReviewQueueRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly getCurrentSkill: (projectId: string) => Promise<Skill>
  ) {}

  async createReviewQueue(input: CreateReviewQueueInputDb): Promise<ReviewQueue> {
    const criterionVersionId = await this.resolveReviewCriterionVersion(
      input.projectId,
      input.criterionVersionId,
      input.skillVersionId
    );
    // Validate every case belongs to this project before we open a transaction;
    // a missing case should fail fast with a typed error, not a generic FK
    // violation downstream.
    const distinctCaseIds = [...new Set(input.caseIds)];
    const validation = await this.pool.query(
      `select id from cases where project_id = $1 and id = any($2::text[])`,
      [input.projectId, distinctCaseIds]
    );
    const foundIds = new Set(validation.rows.map((row) => String(row.id)));
    const missing = distinctCaseIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Cases not found in project: ${missing.join(", ")}`);
    }

    const pins = new Map(await Promise.all(distinctCaseIds.map(async (caseId) =>
      [caseId, await this.resolveEvidencePin(input.projectId, caseId, criterionVersionId, input.skillVersionId)] as const
    )));
    const queueId = `revq_${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into review_queues (id, project_id, name, description, created_by_user_id)
         values ($1,$2,$3,$4,$5)`,
        [queueId, input.projectId, input.name, input.description ?? null, input.createdByUserId ?? null]
      );
      let position = 0;
      for (const caseId of distinctCaseIds) {
        await client.query(
          `insert into review_queue_items (id, queue_id, case_id, criterion_version_id, position, skill_version_id, judge_run_id)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [`revqi_${randomUUID()}`, queueId, caseId, criterionVersionId, position, pins.get(caseId)!.skillVersionId, pins.get(caseId)!.judgeRunId]
        );
        position += 1;
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const detail = await this.getReviewQueueDetail(input.projectId, queueId);
    if (!detail) throw new Error(`Review queue not found after creation: ${queueId}`);
    return detail.queue;
  }

  async listReviewQueues(projectId: string, opts?: { status?: ReviewQueueStatus | undefined }): Promise<ReviewQueue[]> {
    const result = await this.pool.query(
      `select rq.*,
              coalesce(sum(case when rqi.status = 'pending' then 1 else 0 end), 0)::int as pending_count,
              coalesce(sum(case when rqi.status = 'completed' then 1 else 0 end), 0)::int as completed_count
       from review_queues rq
       left join review_queue_items rqi on rqi.queue_id = rq.id
       where rq.project_id = $1
         and ($2::text is null or rq.status = $2)
       group by rq.id
       order by rq.created_at desc`,
      [projectId, opts?.status ?? null]
    );
    return result.rows.map(rowToReviewQueue);
  }

  async getReviewQueueDetail(projectId: string, queueId: string): Promise<ReviewQueueDetail | null> {
    const queueRows = await this.pool.query(
      `select rq.*,
              coalesce(sum(case when rqi.status = 'pending' then 1 else 0 end), 0)::int as pending_count,
              coalesce(sum(case when rqi.status = 'completed' then 1 else 0 end), 0)::int as completed_count
       from review_queues rq
       left join review_queue_items rqi on rqi.queue_id = rq.id
       where rq.id = $1 and rq.project_id = $2
       group by rq.id`,
      [queueId, projectId]
    );
    if (!queueRows.rows[0]) return null;
    const itemRows = await this.pool.query(
      `select * from review_queue_items where queue_id = $1 order by position asc`,
      [queueId]
    );
    return {
      queue: rowToReviewQueue(queueRows.rows[0]),
      items: itemRows.rows.map(rowToReviewQueueItem)
    };
  }

  async getNextPendingQueueItem(projectId: string, queueId: string, opts?: {
    assignedToUserId?: string | undefined;
    criterionVersionId?: string | undefined;
  }): Promise<ReviewQueueItem | null> {
    // Closed queues return null. With assignee filter: match items assigned to
    // that reviewer OR unassigned (the unassigned pool is shared). Without
    // filter: return any pending item.
    if (!opts?.criterionVersionId) {
      const scope = await this.pool.query(
        `select count(distinct criterion_version_id)::int as criterion_count
         from review_queue_items
         where queue_id = $1 and status = 'pending'`,
        [queueId]
      );
      const criterionCount = Number(scope.rows[0]?.criterion_count ?? 0);
      if (criterionCount > 1) {
        throw new AmbiguousProjectSkillError(projectId, Math.max(2, criterionCount));
      }
    } else {
      await this.resolveReviewCriterionVersion(projectId, opts.criterionVersionId);
    }
    const result = await this.pool.query(
      `select rqi.*
       from review_queue_items rqi
       join review_queues rq on rq.id = rqi.queue_id
       where rq.id = $1 and rq.project_id = $2 and rq.status = 'open' and rqi.status = 'pending'
         and ($3::text is null or rqi.assigned_to_user_id is null or rqi.assigned_to_user_id = $3)
         and ($4::text is null or rqi.criterion_version_id = $4)
       order by rqi.position asc
       limit 1`,
      [queueId, projectId, opts?.assignedToUserId ?? null, opts?.criterionVersionId ?? null]
    );
    return result.rows[0] ? rowToReviewQueueItem(result.rows[0]) : null;
  }

  async addReviewQueueItems(input: AddQueueItemsInputDb): Promise<ReviewQueueItem[]> {
    // Queue must exist in this project.
    const queueRow = await this.pool.query(
      `select id from review_queues where id = $1 and project_id = $2`,
      [input.queueId, input.projectId]
    );
    if (!queueRow.rowCount) throw new Error(`Review queue not found: ${input.queueId}`);

    // Validate every case belongs to this project before touching the queue.
    const caseIds = [...new Set(input.items.map((item) => item.caseId))];
    const validation = await this.pool.query(
      `select id from cases where project_id = $1 and id = any($2::text[])`,
      [input.projectId, caseIds]
    );
    const found = new Set(validation.rows.map((row) => String(row.id)));
    const missing = caseIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`Cases not found in project: ${missing.join(", ")}`);
    }
    const resolvedItems = await Promise.all(input.items.map(async (item) => ({
      ...item,
      criterionVersionId: await this.resolveReviewCriterionVersion(
        input.projectId,
        item.criterionVersionId,
        item.skillVersionId
      )
    })));

    const pinnedItems = await Promise.all(resolvedItems.map(async (item) => ({
      ...item,
      ...await this.resolveEvidencePin(input.projectId, item.caseId, item.criterionVersionId, item.skillVersionId)
    })));

    const added: ReviewQueueItem[] = [];
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const lockedQueue = await client.query(`select id from review_queues where id=$1 and project_id=$2 and status='open' for update`, [input.queueId, input.projectId]);
      if (!lockedQueue.rowCount) throw new DatasetRevisionConflictError("Review queue is missing or closed");
      const positionRow = await client.query(`select coalesce(max(position)+1,0)::int as position from review_queue_items where queue_id=$1`, [input.queueId]);
      let position = Number(positionRow.rows[0]?.position ?? 0);
      for (const item of pinnedItems) {
        // ON CONFLICT DO NOTHING deduplicates the exact
        // (queue, case, criterion version, assignee) tuple.
        const result = await client.query(
          `insert into review_queue_items
             (id, queue_id, case_id, criterion_version_id, position, assigned_to_user_id, skill_version_id, judge_run_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict do nothing
           returning *`,
          [
            `revqi_${randomUUID()}`,
            input.queueId,
            item.caseId,
            item.criterionVersionId,
            position,
            item.assignedToUserId ?? null,
            item.skillVersionId,
            item.judgeRunId
          ]
        );
        if (result.rows[0]) {
          added.push(rowToReviewQueueItem(result.rows[0]));
          position += 1;
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return added;
  }

  async closeReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    const updated = await this.pool.query(
      `update review_queues
       set status = 'closed', closed_at = now()
       where id = $1 and project_id = $2 and status <> 'closed'
       returning id`,
      [queueId, projectId]
    );
    if (!updated.rowCount) {
      // Either not found or already closed — fall through to detail lookup so
      // already-closed queues still return their current row (idempotent).
      const detail = await this.getReviewQueueDetail(projectId, queueId);
      return detail ? detail.queue : null;
    }
    const detail = await this.getReviewQueueDetail(projectId, queueId);
    return detail ? detail.queue : null;
  }

  async reopenReviewQueue(projectId: string, queueId: string): Promise<ReviewQueue | null> {
    const updated = await this.pool.query(
      `update review_queues
       set status = 'open', closed_at = null
       where id = $1 and project_id = $2 and status <> 'open'
       returning id`,
      [queueId, projectId]
    );
    if (!updated.rowCount) {
      const detail = await this.getReviewQueueDetail(projectId, queueId);
      return detail ? detail.queue : null;
    }
    const detail = await this.getReviewQueueDetail(projectId, queueId);
    return detail ? detail.queue : null;
  }

  private async resolveEvidencePin(projectId: string, caseId: string, criterionVersionId: string, skillVersionId?: string) {
    // Omission retains the older criterion-only API contract, explicitly unpinned.
    if (!skillVersionId) return { skillVersionId: null, judgeRunId: null };
    const result = await this.pool.query(
      `select run.id from judge_runs run
       join skill_versions version on version.id = run.skill_version_id and version.project_id = run.project_id
       where run.project_id = $1 and run.case_id = $2 and run.skill_version_id = $3
         and version.criterion_version_id = $4
       order by run.created_at desc, run.id desc limit 1`,
      [projectId, caseId, skillVersionId, criterionVersionId]
    );
    if (!result.rows[0]) throw new DatasetRevisionConflictError(`No recorded result for case ${caseId} and selected evaluator version`);
    return { skillVersionId, judgeRunId: String(result.rows[0].id) };
  }

  private async resolveReviewCriterionVersion(
    projectId: string,
    requested?: string | undefined,
    skillVersionId?: string | undefined
  ): Promise<string> {
    if (skillVersionId) {
      const result = await this.pool.query(
        `select criterion_version_id from skill_versions where project_id = $1 and id = $2`,
        [projectId, skillVersionId]
      );
      const criterion = result.rows[0]?.criterion_version_id;
      if (!criterion || (requested && requested !== criterion)) {
        throw new DatasetRevisionConflictError("Evaluator version does not match this project and criterion");
      }
      return String(criterion);
    }
    if (requested) {
      const result = await this.pool.query(
        `select version.id
         from criterion_versions version
         where version.project_id = $1
           and version.id = $2
           and exists (
             select 1
             from skill_versions evaluator
             where evaluator.project_id = version.project_id
               and evaluator.criterion_version_id = version.id
           )`,
        [projectId, requested]
      );
      if (!result.rowCount) {
        throw new DatasetRevisionConflictError(
          `Criterion version is not bound to an evaluator in this project: ${requested}`
        );
      }
      return requested;
    }
    const current = await this.getCurrentSkill(projectId);
    const row = (await this.pool.query(
      `select criterion_version_id
       from skill_versions
       where project_id = $1 and id = $2`,
      [projectId, current.currentVersion.id]
    )).rows[0];
    const criterionVersionId = String(row?.criterion_version_id ?? "");
    if (!criterionVersionId) {
      throw new DatasetRevisionConflictError("Current evaluator has no immutable criterion version binding");
    }
    return criterionVersionId;
  }
}
