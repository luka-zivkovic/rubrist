import { sqliteLimit } from './query-values.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { isInternalTraceMetadata, type CaseSource, type ManualTraceImportInput } from '@rubrist/shared';
import { normalizeTracePayload, redactNormalizedTracePayload } from '../../lib/redaction.js';
import { datasetInputIdentity } from '../../lib/dataset-revision.js';
import { assertTraceIngestionPurpose } from '../../repository/helpers.js';
import { RecursiveTraceSkippedError } from '../../repository/errors.js';
import type { CaseSourceIdentity, ListCasesOptions, TraceImportContext, TraceImportResult } from '../../repository/contracts.js';

export function sqliteTraceCommands(db: DatabaseSync) {
  const one=(sql:string,...args:SQLInputValue[])=>db.prepare(sql).get(...args);
  const run=(sql:string,...args:SQLInputValue[])=>db.prepare(sql).run(...args);
  const commands = {
    importTrace(projectId: string, source: CaseSource, input: ManualTraceImportInput, context: TraceImportContext): TraceImportResult {
      assertTraceIngestionPurpose(source,context.ingestionPurpose);
      if(isInternalTraceMetadata(input.metadata)) throw new RecursiveTraceSkippedError(input.sourceTraceId);
      if(!['manual','release_evidence'].includes(source) || context.sourceIntegrationId || context.importJobId) {
        throw new Error('Integration import storage is not yet available in SQLite');
      }
      if(db.isTransaction) throw new Error('Nested SQLite trace import');
      db.exec('BEGIN IMMEDIATE');
      try {
        const now=new Date().toISOString();
        const sourceTraceId=input.sourceTraceId?.trim() || `${source}_${randomUUID()}`;
        const existing=one(`SELECT rt.id raw_trace_id,c.id case_id FROM raw_traces rt JOIN cases c ON c.raw_trace_id=rt.id AND c.project_id=rt.project_id
          WHERE rt.project_id=? AND rt.source=? AND rt.source_trace_id=? AND rt.source_trace_version IS ? AND rt.source_remote_project_id IS ?`,
          projectId,source,sourceTraceId,context.sourceTraceVersion??null,context.sourceRemoteProjectId??null);
        let result: TraceImportResult;
        if(existing) result={rawTraceId:String(existing.raw_trace_id),caseId:String(existing.case_id),sourceTraceId,created:false};
        else {
          const rawTraceId=`raw_${randomUUID()}`, caseId=`case_${randomUUID()}`;
          const raw=normalizeTracePayload(input), normalized=redactNormalizedTracePayload(raw,context.redactionConfig);
          run('INSERT INTO raw_traces VALUES(?,?,?,?,?,?,?,?,?,?,?)',rawTraceId,projectId,source,null,context.sourceRemoteProjectId??null,
            sourceTraceId,context.sourceTraceVersion??null,null,JSON.stringify(raw),context.normalizationVersion??`${source}-v1`,now);
          run('INSERT INTO cases VALUES(?,?,?,?,?,?,?)',caseId,projectId,rawTraceId,source,JSON.stringify(normalized),now,context.ingestionPurpose);
          const identity=datasetInputIdentity({input:input.input});
          run('INSERT INTO case_input_identity_records VALUES(?,?,?,?,?,?,?)',`ciir_${randomUUID()}`,projectId,caseId,'authoring_import',identity.basis,identity.digest,now);
          if(source!=='release_evidence') run('UPDATE projects SET imported_trace_count=imported_trace_count+1,updated_at=? WHERE id=?',now,projectId);
          result={rawTraceId,caseId,sourceTraceId,created:true};
        }
        db.exec('COMMIT'); return result;
      } catch(error) { if(db.isTransaction) db.exec('ROLLBACK'); throw error; }
    },
    getCaseSourceIdentity(projectId: string, caseId: string): CaseSourceIdentity | null {
      const row=one('SELECT rt.* FROM raw_traces rt JOIN cases c ON c.raw_trace_id=rt.id AND c.project_id=rt.project_id WHERE c.project_id=? AND c.id=?',projectId,caseId);
      return row?{source:String(row.source) as CaseSource,sourceTraceId:String(row.source_trace_id),sourceTraceVersion:row.source_trace_version as string|null,
        sourceRemoteProjectId:row.source_remote_project_id as string|null,sourceIntegrationId:row.source_integration_id as string|null}:null;
    },
    caseExistsForProject(projectId: string, caseId: string) { return Boolean(one('SELECT 1 FROM cases WHERE project_id=? AND id=?',projectId,caseId)); },
    listCaseIdsForProject(projectId: string, limit=10_000): string[] {
      return db.prepare("SELECT id FROM cases WHERE project_id=? AND case_type<>'release_evidence' ORDER BY created_at DESC,id LIMIT ?").all(projectId,sqliteLimit(limit)).map(row=>String(row.id));
    },
    listCases(projectId: string, opts: ListCasesOptions={}) {
      const since=opts.since===undefined?null:new Date(opts.since).toISOString();
      return db.prepare(`SELECT c.*,rt.source_trace_id FROM cases c JOIN raw_traces rt ON rt.id=c.raw_trace_id AND rt.project_id=c.project_id
        WHERE c.project_id=? AND c.case_type<>'release_evidence' AND (? IS NULL OR c.created_at>?)
        ORDER BY c.created_at DESC,c.id LIMIT ?`).all(projectId,since,since,sqliteLimit(opts.limit??500)).map(row=>{
          const payload=redactNormalizedTracePayload(JSON.parse(String(row.normalized_payload)));
          return {caseId:String(row.id),sourceTraceId:String(row.source_trace_id),createdAt:String(row.created_at),
            trace:{input:payload.input??null,output:payload.output??null,metadata:payload.metadata??{},...(payload.steps?{steps:payload.steps}:{})}};
        });
    }
  };
  return commands;
}
