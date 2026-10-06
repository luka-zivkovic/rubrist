import {AnalysisMeasurementRepositoryError} from '../../analysis-measurement/repository.js';
import {EvaluatorLifecycleRepositoryError} from '../../evaluator-lifecycle/repository.js';
import {BinaryCalibrationRepositoryError} from '../../binary-calibration/repository.js';
import {AnalysisPromotionRepositoryError} from '../../analysis-promotion/repository.js';
import * as governedErrors from '../../governed-review/errors.js';
import { AnalysisStudyRepositoryError } from '../../analysis-study/repository.js';
import { AnalysisPopulationRepositoryError } from '../../analysis-population/repository.js';
import { ProductionRecordRepositoryError } from '../../production-calibration/repository.js';
import { SqliteFeatureUnavailableError } from './feature-error.js';
import * as repositoryErrors from '../../repository/errors.js';
import { Worker } from 'node:worker_threads';
import type { RubristAuth } from '../../lib/auth.js';
import { AgentSetupPairingInProgressError } from '../../lib/auth.js';
import type { SqliteCommands } from './commands.js';
import { createCommandClockDriftMonitor } from './clock-drift.js';

export class SqliteStorage {
  private readonly worker: Worker;
  private sequence = 0;
  private closed = false;
  private failure: Error | null = null;
  private readonly pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  readonly ready: Promise<void>;
  private readonly clock: ReturnType<typeof createCommandClockDriftMonitor>;
  constructor(path: string, options:{seedStarterEvaluators?:boolean;onFailure?:()=>void;exclusiveInstance?:boolean}={}) {
    this.clock = createCommandClockDriftMonitor();
    const source = import.meta.url.endsWith('.ts');
    this.worker = new Worker(new URL(source ? './worker.ts' : './worker.js',import.meta.url), {
      workerData:{path,exclusiveInstance:options.exclusiveInstance??false,seedStarterEvaluators:options.seedStarterEvaluators??true}, ...(source ? {execArgv:['--import','tsx']} : {})
    });
    let initialized = false;
    this.ready = new Promise((resolve,reject) => {
      this.worker.on('message',message => {
        if (message.ready) { initialized=true; this.clock.observe(message.clockAheadMs); resolve(); return; }
        const caller = this.pending.get(message.id);
        if (!caller) return;
        this.pending.delete(message.id);
        if (message.error) {
          const error = message.error.name === 'AgentSetupPairingInProgressError' ? new AgentSetupPairingInProgressError() : Object.assign(new Error(message.error.message),message.error);
          if(message.error.name==='AnalysisMeasurementRepositoryError')Object.setPrototypeOf(error,AnalysisMeasurementRepositoryError.prototype);
          if(message.error.name==='BinaryCalibrationRepositoryError')Object.setPrototypeOf(error,BinaryCalibrationRepositoryError.prototype);
          if(message.error.name==='EvaluatorLifecycleRepositoryError')Object.setPrototypeOf(error,EvaluatorLifecycleRepositoryError.prototype);
          if(message.error.name==='AnalysisPromotionRepositoryError')Object.setPrototypeOf(error,AnalysisPromotionRepositoryError.prototype);
          if(message.error.name==='AnalysisStudyRepositoryError') Object.setPrototypeOf(error,AnalysisStudyRepositoryError.prototype);
          if(message.error.name==='AnalysisPopulationRepositoryError') Object.setPrototypeOf(error,AnalysisPopulationRepositoryError.prototype);
          if(message.error.name==='ProductionRecordRepositoryError') Object.setPrototypeOf(error,ProductionRecordRepositoryError.prototype);
          if(message.error.name==='SqliteFeatureUnavailableError') Object.setPrototypeOf(error,SqliteFeatureUnavailableError.prototype);
          const domainError = Object.hasOwn(repositoryErrors,message.error.name)
            ? repositoryErrors[message.error.name as keyof typeof repositoryErrors] : undefined;
          if (typeof domainError === 'function' && domainError.prototype instanceof Error) Object.setPrototypeOf(error,domainError.prototype);
          const governedError=Object.hasOwn(governedErrors,message.error.name)?governedErrors[message.error.name as keyof typeof governedErrors]:undefined;
          if(typeof governedError==='function'&&(governedError===governedErrors.GovernedReviewDomainError||governedError.prototype instanceof governedErrors.GovernedReviewDomainError))Object.setPrototypeOf(error,governedError.prototype);
          caller.reject(error);
        } else caller.resolve(reviveBytes(message.result));
      });
      const failed = (error: Error) => {
        const firstFailure=!this.failure;
        this.failure=error; reject(error);
        for (const caller of this.pending.values()) caller.reject(error);
        this.pending.clear();
        if(initialized && firstFailure && !this.closed) options.onFailure?.();
      };
      this.worker.on('error',failed);
      this.worker.on('exit',code => { if (!this.closed) failed(new Error(`SQLite worker exited (${code})`)); });
    });
  }
  private async request(message: Record<string,unknown>): Promise<any> {
    await this.ready;
    if (this.closed || this.failure) throw this.failure ?? new Error('SQLite storage is closed');
    return new Promise((resolve,reject) => {
      const id = ++this.sequence;
      this.pending.set(id,{resolve,reject});
      this.worker.postMessage({...message,id});
    });
  }
  command<K extends keyof SqliteCommands>(name: K, ...args: Parameters<SqliteCommands[K]>): Promise<ReturnType<SqliteCommands[K]>> {
    return this.request({kind:'command',name,args});
  }
  /** A managed write round trip; it also reports command-clock drift without failing on it. */
  async probe(): Promise<void> { this.clock.observe((await this.request({kind:'probe'}))?.clockAheadMs); }
  auth(): RubristAuth {
    const api = Object.fromEntries(['getSession','signUpEmail','signInEmail'].map(name => [name,async (input: Record<string,unknown>) => {
      const result = await this.request({kind:'auth-api',name,input:{...input,...(input.headers ? {headers:[...new Headers(input.headers as ConstructorParameters<typeof Headers>[0])]}: {})}});
      if (input.returnHeaders) {
        const headers = new Headers(result.headers);
        headers.delete('set-cookie');
        for (const cookie of result.cookies) headers.append('set-cookie',cookie);
        return {headers,response:result.response};
      }
      return result;
    }]));
    return {
      api: api as unknown as RubristAuth['api'],
      handler: async (request: Request) => {
        const reply = await this.request({kind:'auth-handler',request:{url:request.url,method:request.method,headers:[...request.headers],body:['GET','HEAD'].includes(request.method) ? null : await request.text()}});
        const headers = new Headers(reply.headers); headers.delete('set-cookie');
        for (const cookie of reply.cookies) headers.append('set-cookie',cookie);
        return new Response(reply.body || null,{status:reply.status,headers});
      }
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.failure) { this.closed=true; await this.worker.terminate(); return; }
    try { await this.request({kind:'close'}); }
    finally { this.closed=true; await this.worker.terminate(); }
  }
}

// Worker structured cloning preserves bytes as Uint8Array, not Buffer. Existing
// repository consumers use Buffer.equals/toString for canonical evidence.
function reviveBytes(value:any):any {
  if(value instanceof Uint8Array) return Buffer.from(value);
  if(Array.isArray(value)) return value.map(reviveBytes);
  if(value && Object.getPrototypeOf(value)===Object.prototype) return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,reviveBytes(item)]));
  return value;
}
