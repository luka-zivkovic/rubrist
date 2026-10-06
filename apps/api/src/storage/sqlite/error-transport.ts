import { ProductionRecordRepositoryError } from '../../production-calibration/repository.js';
import { GoldenSetRetirementContextSchema } from '@rubrist/shared';
import * as repositoryErrors from '../../repository/errors.js';

// Only public error contract fields cross the worker boundary. In particular,
// driver SQL, parameters, causes and arbitrary enumerable properties do not.
export function serializeSqliteError(error: unknown): Record<string, unknown> {
  const value = error instanceof Error ? error : new Error('SQLite command failed');
  const result: Record<string, unknown> = {name:value.name,message:value.message};
  const fields = value as unknown as Record<string,unknown>;
  if (typeof fields.statusCode === 'number') result.statusCode=fields.statusCode;
  if (fields.body && typeof fields.body === 'object') {
    const body=fields.body as Record<string,unknown>;
    result.body=Object.fromEntries(['code','message'].flatMap(key=>typeof body[key]==='string' ? [[key,body[key]]] : []));
  }
  const DomainError=Object.hasOwn(repositoryErrors,value.name)
    ? repositoryErrors[value.name as keyof typeof repositoryErrors] : undefined;
  if (DomainError && value instanceof DomainError) {
    for (const key of ['code','reason','revisionId','jobDatasetRevisionId','versionDatasetRevisionId','provider',
      'projectId','criterionCount','stableKey','idempotencyKey','expectedRevision','currentRevision']) {
      if (typeof fields[key]==='string' || typeof fields[key]==='number') result[key]=fields[key];
    }
  }
  if(value instanceof repositoryErrors.GoldenSetEntryAlreadyRetiredError) {
    const retirement=GoldenSetRetirementContextSchema.nullable().safeParse(value.retirement);
    if(retirement.success)result.retirement=retirement.data;
  }
  if(value instanceof ProductionRecordRepositoryError) {
    result.code=value.code;
    result.details=Object.fromEntries(['line','bytes','maximum','records','decisionId','from','to','bound'].flatMap(key=>{
      const item=value.details[key];return item===null||['string','number','boolean'].includes(typeof item)?[[key,item]]:[];
    }));
  }
  return result;
}
