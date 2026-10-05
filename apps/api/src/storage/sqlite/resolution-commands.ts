import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ExecutionBindingSchema, ResolutionRecordSchema, VerdictKindSchema, type ExecutionBinding, type ResolutionRecord } from '@rubrist/shared';
import { CAPABILITY_CHECK_CARRY_MS, combineCapabilityChecks, type StoredCapabilityCheck } from '../../lib/capability-check-store.js';
import type { ResolutionAttemptInput } from '../../evaluator-lifecycle/resolution.pg.js';
import type { GovernedBinding } from '../../lib/binding-resolution.js';
import { sha256Digest } from '../../lib/canonical-json.js';
import { evaluationDatabase, parse } from './evaluation-values.js';

// These synchronous helpers share the caller's transaction when a later
// lifecycle operation must persist its binding resolution atomically.
export function sqliteResolutionStore(db: DatabaseSync) {
  const {one,run}=evaluationDatabase(db);
  function load(projectId:string,versionId:string,binding:ExecutionBinding):ResolutionRecord|null {
    const row=one('SELECT record,binding_digest FROM evaluator_resolution_records WHERE project_id=? AND skill_version_id=?',projectId,versionId);
    if(!row||row.binding_digest!==sha256Digest(binding))return null;
    const parsed=ResolutionRecordSchema.safeParse(parse(row.record));return parsed.success?parsed.data:null;
  }
  return {
    load,
    save(projectId:string,versionId:string,binding:ExecutionBinding,record:ResolutionRecord,options:{onlyOverUnresolved?:boolean}={}) {
      if(!db.isTransaction)throw new Error('Resolution save requires an owned transaction');
      const parsed=ResolutionRecordSchema.parse(record),digest=sha256Digest(binding);
      const stored=one('SELECT * FROM evaluator_resolution_records WHERE skill_version_id=?',versionId);
      if(stored&&stored.project_id!==projectId)throw new Error('The evaluator version\'s resolution record belongs to another project');
      if(stored&&stored.binding_digest===digest&&ResolutionRecordSchema.safeParse(parse(stored.record)).success&&
        (stored.status==='failed'||options.onlyOverUnresolved&&stored.status!=='unresolved'))return load(projectId,versionId,binding);
      run(`INSERT INTO evaluator_resolution_records VALUES(?,?,?,?,?,?) ON CONFLICT(skill_version_id) DO UPDATE SET
        binding_digest=excluded.binding_digest,status=excluded.status,record=excluded.record,recorded_at=excluded.recorded_at`,versionId,projectId,digest,parsed.status,JSON.stringify(parsed),new Date().toISOString());
      return load(projectId,versionId,binding);
    },
    append(attempt:ResolutionAttemptInput) {
      run('INSERT INTO evaluator_resolution_attempts VALUES(?,?,?,?,?,?,?,?,?,?)',`era_${randomUUID()}`,attempt.projectId,attempt.skillVersionId,sha256Digest(attempt.executionBinding),attempt.kind,attempt.triggerKind,attempt.triggerRef,attempt.outcome,JSON.stringify(attempt.probes),new Date().toISOString());
    },
    binding(projectId:string,versionId:string):GovernedBinding|null {
      const row=one('SELECT * FROM skill_versions WHERE project_id=? AND id=?',projectId,versionId);
      return row?{projectId,executionBinding:ExecutionBindingSchema.parse(parse(row.execution_binding)),customEndpointUrl:row.custom_endpoint_url,
        spec:{verdictKind:VerdictKindSchema.parse(row.verdict_kind),scalarRange:parse(row.scalar_range),categoricalChoiceScores:parse(row.categorical_choice_scores)}}:null;
    },
    msSinceUnknownRecheck(projectId:string,runId:string):number|null {
      const row=one("SELECT max(recorded_at) recorded_at FROM evaluator_resolution_attempts WHERE project_id=? AND trigger_kind='binary_calibration_run' AND trigger_ref=? AND kind='recheck' AND outcome='unknown'",projectId,runId);
      return row?.recorded_at==null?null:Date.now()-Date.parse(row.recorded_at);
    }
  };
}
export function sqliteResolutionCommands(db:DatabaseSync) {
  const {all,run,transaction}=evaluationDatabase(db),store=sqliteResolutionStore(db);
  return {
    capabilityCheckPut(entry:StoredCapabilityCheck) { transaction(()=> {
      run('INSERT INTO evaluator_capability_checks(id,project_id,context_digest,checked_at,classification,check_result) VALUES(?,?,?,?,?,?)',randomUUID(),entry.projectId,entry.contextDigest,entry.checkedAt.getTime(),Number(entry.classification),JSON.stringify(entry.check));
      run('DELETE FROM evaluator_capability_checks WHERE checked_at<=?',entry.checkedAt.getTime()-CAPABILITY_CHECK_CARRY_MS);
    }); },
    capabilityCheckGet(projectId:string,contextDigest:string,now:Date,binding:ExecutionBinding) {
      const entries=all('SELECT * FROM evaluator_capability_checks WHERE project_id=? AND context_digest=? AND checked_at>? AND checked_at<=? ORDER BY checked_at,sequence',projectId,contextDigest,now.getTime()-CAPABILITY_CHECK_CARRY_MS,now.getTime());
      return combineCapabilityChecks(entries.map(row=>({projectId,contextDigest,checkedAt:new Date(row.checked_at),classification:Boolean(row.classification),check:parse(row.check_result)})),binding);
    },
    getGovernedBinding(access:{projectId:string},versionId:string) {
      const binding=store.binding(access.projectId,versionId);return binding?{binding,record:store.load(access.projectId,versionId,binding.executionBinding)}:null;
    },
    recordResolution(attempt:ResolutionAttemptInput,record:ResolutionRecord|null) { return transaction(()=> {
      store.append(attempt);
      return record!==null&&attempt.skillVersionId!==null?store.save(attempt.projectId,attempt.skillVersionId,attempt.executionBinding,record,{onlyOverUnresolved:attempt.triggerKind==='version_save'}):record;
    }); },
    msSinceUnknownRecheck:store.msSinceUnknownRecheck
  };
}
