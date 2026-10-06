import { createSqliteRuntime } from '../../src/storage/sqlite/runtime.js';
import type { JudgeProviderFactory } from '../../src/lib/judge-provider.js';
// Existing isolated persistence fixtures author their own exact criterion.
// Production starter creation is tested separately through the real runtime.
export const createUnseededSqliteRuntime=(path:string,factory?:JudgeProviderFactory)=>createSqliteRuntime(path,factory,{seedStarterEvaluators:false});
