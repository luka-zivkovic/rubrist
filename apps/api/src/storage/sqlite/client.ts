import { Worker } from 'node:worker_threads';
import type { RubristAuth } from '../../lib/auth.js';
import { AgentSetupPairingInProgressError } from '../../lib/auth.js';
import type { SqliteCommands } from './commands.js';

export class SqliteStorage {
  private readonly worker: Worker;
  private sequence = 0;
  private closed = false;
  private failure: Error | null = null;
  private readonly pending = new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  readonly ready: Promise<void>;
  constructor(path: string) {
    const source = import.meta.url.endsWith('.ts');
    this.worker = new Worker(new URL(source ? './worker.ts' : './worker.js',import.meta.url), {
      workerData:{path}, ...(source ? {execArgv:['--import','tsx']} : {})
    });
    this.ready = new Promise((resolve,reject) => {
      this.worker.on('message',message => {
        if (message.ready) { resolve(); return; }
        const caller = this.pending.get(message.id);
        if (!caller) return;
        this.pending.delete(message.id);
        if (message.error) {
          const error = message.error.name === 'AgentSetupPairingInProgressError' ? new AgentSetupPairingInProgressError() : Object.assign(new Error(message.error.message),message.error);
          caller.reject(error);
        } else caller.resolve(message.result);
      });
      const failed = (error: Error) => {
        this.failure=error; reject(error);
        for (const caller of this.pending.values()) caller.reject(error);
        this.pending.clear();
      };
      this.worker.on('error',failed);
      this.worker.on('exit',code => { if (!this.closed || code !== 0) failed(new Error(`SQLite worker exited (${code})`)); });
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
