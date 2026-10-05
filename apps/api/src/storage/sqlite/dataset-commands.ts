import { sqliteCommand } from './command-context.js';
import { importTraceInTransaction } from './trace-commands.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { DatasetSchema, DatasetItemSchema } from '@rubrist/shared';
import type { AddDatasetItemsInputDb, CreateDatasetInputDb, ImportDatasetExamplesDbInput } from '../../repository/contracts.js';
import { DatasetNameTakenError, DatasetNotFoundError, CaseNotFoundError } from '../../repository/errors.js';

type Row=Record<string,any>;
function dataset(row:Row,count:number) {
  return DatasetSchema.parse({id:row.id,projectId:row.project_id,name:row.name,description:row.description,kind:row.kind,
    itemCount:count,createdAt:row.created_at,archivedAt:row.archived_at});
}
function item(row:Row) {
  return DatasetItemSchema.parse({id:row.id,datasetId:row.dataset_id,caseId:row.case_id,traceId:row.trace_id,
    expectedLabel:row.expected_label,expectedFailStep:row.expected_fail_step,note:row.note,addedAt:row.added_at});
}
export function sqliteDatasetCommands(db:DatabaseSync) {
  const one=(sql:string,...args:SQLInputValue[])=>db.prepare(sql).get(...args) as Row|undefined;
  const all=(sql:string,...args:SQLInputValue[])=>db.prepare(sql).all(...args) as Row[];
  function transaction<T>(work:(now:string)=>T):T {
    return sqliteCommand(db,context=>work(context.timestamp));
  }
  function items(projectId:string,datasetId:string){return all('SELECT * FROM dataset_items WHERE project_id=? AND dataset_id=? ORDER BY added_at,id',projectId,datasetId).map(item);}
  return {
    createDataset(input:CreateDatasetInputDb) {
      return transaction(now=>{
        const name=input.name.trim();
        if(one('SELECT 1 FROM datasets WHERE project_id=? AND name=? AND archived_at IS NULL',input.projectId,name)) throw new DatasetNameTakenError(name);
        const row=one('INSERT INTO datasets VALUES(?,?,?,?,?,?,?,NULL) RETURNING *',`ds_${randomUUID()}`,input.projectId,name,input.description??null,input.kind??'custom',input.createdByUserId??null,now)!;
        return dataset(row,0);
      });
    },
    listDatasets(projectId:string) {
      return all(`SELECT d.*,count(di.id) item_count FROM datasets d LEFT JOIN dataset_items di ON di.dataset_id=d.id AND di.project_id=d.project_id
        WHERE d.project_id=? AND d.archived_at IS NULL GROUP BY d.id ORDER BY d.created_at DESC,d.id`,projectId).map(row=>dataset(row,Number(row.item_count)));
    },
    getDatasetDetail(projectId:string,datasetId:string) {
      const row=one('SELECT * FROM datasets WHERE project_id=? AND id=?',projectId,datasetId);
      if(!row)return null;
      const members=items(projectId,datasetId);return {...dataset(row,members.length),items:members};
    },
    archiveDataset(projectId:string,datasetId:string) {
      return transaction(now=>db.prepare('UPDATE datasets SET archived_at=? WHERE project_id=? AND id=? AND archived_at IS NULL').run(now,projectId,datasetId).changes>0);
    },
    addDatasetItems(input:AddDatasetItemsInputDb) {
      return transaction(now=>{
        upsertDatasetItemsInTransaction(db,input,now);
        return items(input.projectId,input.datasetId);
      });
    },
    importDatasetExamples(input:ImportDatasetExamplesDbInput) {
      return transaction(now=> {
        if(!one('SELECT 1 FROM datasets WHERE project_id=? AND id=? AND archived_at IS NULL',input.projectId,input.datasetId)) throw new DatasetNotFoundError(input.datasetId);
        return {items:input.items.map(example=> {
          const imported=importTraceInTransaction(db,input.projectId,'manual',example,{ingestionPurpose:input.ingestionPurpose},now);
          upsertDatasetItemsInTransaction(db,{projectId:input.projectId,datasetId:input.datasetId,items:[{caseId:imported.caseId,expectedLabel:example.expectedLabel,expectedFailStep:example.expectedFailStep,note:example.note}]},now);
          const stored=one('SELECT id FROM dataset_items WHERE project_id=? AND dataset_id=? AND case_id=?',input.projectId,input.datasetId,imported.caseId)!;
          return {sourceTraceId:imported.sourceTraceId,caseId:imported.caseId,created:imported.created,datasetItemId:String(stored.id)};
        })};
      });
    },
    removeDatasetItem(projectId:string,datasetId:string,itemId:string) {
      return db.prepare('DELETE FROM dataset_items WHERE project_id=? AND dataset_id=? AND id=?').run(projectId,datasetId,itemId).changes>0;
    }
  };
}

// Internal caller-owned write: no nested commit can leave orphan examples.
function upsertDatasetItemsInTransaction(db:DatabaseSync,input:AddDatasetItemsInputDb,now:string) {
  if(!db.isTransaction) throw new Error('Dataset upsert requires its owning transaction');
  const one=(sql:string,...args:SQLInputValue[])=>db.prepare(sql).get(...args) as Row|undefined;
        if(!one('SELECT 1 FROM datasets WHERE project_id=? AND id=? AND archived_at IS NULL',input.projectId,input.datasetId)) throw new DatasetNotFoundError(input.datasetId);
        for(const member of input.items) {
          const source=one('SELECT rt.source_trace_id FROM cases c JOIN raw_traces rt ON rt.id=c.raw_trace_id AND rt.project_id=c.project_id WHERE c.project_id=? AND c.id=?',input.projectId,member.caseId);
          if(!source)throw new CaseNotFoundError(member.caseId);
          db.prepare(`INSERT INTO dataset_items VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset_id,case_id) DO UPDATE SET
            expected_label=coalesce(excluded.expected_label,dataset_items.expected_label),
            expected_fail_step=CASE WHEN coalesce(excluded.expected_label,dataset_items.expected_label)='pass' THEN NULL WHEN excluded.expected_fail_step IS NOT NULL
              THEN excluded.expected_fail_step ELSE dataset_items.expected_fail_step END,
            note=coalesce(excluded.note,dataset_items.note)`).run(`dsi_${randomUUID()}`,input.datasetId,input.projectId,member.caseId,String(source.source_trace_id),
              member.expectedLabel??null,member.note??null,now,member.expectedFailStep??null);
        }
}
