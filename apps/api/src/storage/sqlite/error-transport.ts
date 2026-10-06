import { GovernedReviewDomainError } from '../../governed-review/errors.js';
import { AnalysisStudyRepositoryError } from '../../analysis-study/repository.js';
import { AnalysisPopulationRepositoryError } from '../../analysis-population/repository.js';
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
    result.details=Object.fromEntries(['line','bytes','maximum','records','decisionId','from','to'].flatMap(key=>{
      const item=value.details[key];return item===null||['string','number','boolean'].includes(typeof item)?[[key,item]]:[];
    }));
  }
  if(value instanceof AnalysisPopulationRepositoryError){
    result.code=value.code;
    result.details=Object.fromEntries(['limit','observed','fixedBudget','existingFixedBudget','requestedFixedBudget'].flatMap(key=>{
      const item=value.details[key];return item===null||['string','number','boolean'].includes(typeof item)?[[key,item]]:[];
    }));
  }
  if(value instanceof AnalysisStudyRepositoryError){
    result.code=value.code;
    result.details=typeof value.details.studyId==='string'?{studyId:value.details.studyId}:{};
  }
  if(value instanceof GovernedReviewDomainError){
    result.code=value.code;result.status=value.status;
    if(value.details)result.details=Object.fromEntries(['currentState','currentVersion','attemptedAction','maxBytes'].flatMap(key=>{const item=value.details![key];return typeof item==='string'||typeof item==='number'?[[key,item]]:[];}));
  }
  return result;
}
