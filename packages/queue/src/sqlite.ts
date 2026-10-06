import type { Queue, QueueJob, QueueJobState, QueueName, QueueSendOptions } from './index.js';

export interface SqliteDelivery extends QueueJob<Record<string, unknown>> {
  token: string; retryCount: number; retryLimit: number;
}
/** Commands execute on the application's serialized storage worker. */
export interface SqliteQueueStore {
  send(name: QueueName, data: object, options?: QueueSendOptions): Promise<string | null>;
  state(name: QueueName, id: string): Promise<QueueJobState | null>;
  claim(name: QueueName): Promise<SqliteDelivery | null>;
  /** Recover expiry even when local slots are full; return lost local tokens. */
  recover(name: QueueName, localTokens: string[]): Promise<string[]>;
  settle(name: QueueName, id: string, token: string, error: string | null): Promise<boolean>;
}
interface LocalDelivery { done: Promise<void>; expire(): void }

export class SqliteQueue implements Queue {
  private running = false;
  private generation = 0;
  private stopping: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private readonly handlers = new Map<QueueName, (job: QueueJob<any>) => Promise<void>>();
  private readonly active = new Map<QueueName, Map<string, LocalDelivery>>();
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly drainMs: number;
  constructor(private readonly store: SqliteQueueStore, options: { concurrency?: number; pollMs?: number; drainMs?: number } = {}) {
    this.concurrency = options.concurrency ?? 4;
    this.pollMs = options.pollMs ?? 250;
    this.drainMs = options.drainMs ?? 10_000;
    for (const value of [this.concurrency,this.pollMs,this.drainMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid SQLite queue configuration');
    }
  }
  async start(): Promise<void> {
    if (this.stopping) throw new Error('SQLite queue is stopping');
    if (this.running) return;
    this.running = true;
    this.tick(++this.generation);
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    ++this.generation;
    clearTimeout(this.timer);
    this.stopping = this.drain();
    try { await this.stopping; } finally { this.stopping = undefined; }
  }
  private async drain(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const drained = await Promise.race([
        (async () => {
          await this.polling;
          await Promise.all([...this.active.values()].flatMap(jobs => [...jobs.values()].map(job => job.done)));
          return true;
        })(),
        new Promise<false>(resolve => { timer=setTimeout(()=>resolve(false),this.drainMs); })
      ]);
      if (!drained) {
        console.error('SQLite queue shutdown deadline reached; unfinished deliveries retain their durable leases for recovery.');
        for (const jobs of this.active.values()) for (const job of jobs.values()) job.expire();
      }
    } finally { clearTimeout(timer); }
  }
  async send<T extends object>(name: QueueName, data: T, options?: QueueSendOptions): Promise<string | null> {
    return this.store.send(name, data, options);
  }
  async getJobState(name: QueueName, id: string): Promise<QueueJobState | null> { return this.store.state(name, id); }
  async work<T extends object>(name: QueueName, handler: (job: QueueJob<T>) => Promise<void>): Promise<void> {
    if (this.handlers.has(name)) throw new Error(`SQLite queue handler already registered: ${name}`);
    this.handlers.set(name, handler);
    this.active.set(name, new Map());
  }
  private tick(generation: number): void {
    if (!this.running || generation !== this.generation) return;
    const polling = this.poll(generation).finally(() => {
      if (this.polling === polling) this.polling = undefined;
      if (this.running && generation === this.generation) {
        this.timer = setTimeout(() => this.tick(generation), this.pollMs); this.timer.unref();
      }
    });
    this.polling = polling;
  }
  private async poll(generation: number): Promise<void> {
    for (const [name, handler] of this.handlers) {
      if (!this.running || generation !== this.generation) break;
      const active = this.active.get(name)!;
      try {
        const lost = await this.store.recover(name,[...active.keys()]);
        if (!this.running || generation !== this.generation) break;
        for (const token of lost) {
          active.get(token)?.expire(); active.delete(token);
        }
        // Bound claims per tick as well as leased concurrency, so fast handlers
        // in a busy queue cannot starve recovery/work in subsequent queues.
        for (let n=0; this.running && generation===this.generation && n<this.concurrency && active.size<this.concurrency; n++) {
          const job = await this.store.claim(name);
          if (!job) break;
          if (!this.running || generation !== this.generation) break; // A racing committed claim recovers by lease.
          const delivery = this.deliver(name,job,handler);
          active.set(job.token,delivery);
          void delivery.done.finally(()=>active.delete(job.token));
        }
      } catch (error) { console.error(`SQLite queue poll failed for ${name}; persisted jobs will be retried:`,error); }
    }
  }
  private deliver(name: QueueName, job: SqliteDelivery, handler: (job: QueueJob<any>) => Promise<void>): LocalDelivery {
    let expired = false;
    let abandon!: () => void;
    const expiration = new Promise<void>(resolve => { abandon=resolve; });
    const work = (async () => {
      let failure: string | null = null;
      try { await handler({id:job.id,data:job.data,retryCount:job.retryCount,retryLimit:job.retryLimit}); }
      catch (error) { failure = error instanceof Error ? error.message : String(error); }
      // Expiry cannot cancel an external request. Domain fencing prevents a
      // stale result from being recorded or a replacement calling twice.
      if (expired) return;
      try { await this.store.settle(name,job.id,job.token,failure); }
      catch (error) { console.error(`SQLite queue acknowledgement failed for ${name}/${job.id}:`,error); }
    })();
    return {done:Promise.race([work,expiration]),expire:()=>{expired=true;abandon();}};
  }
}
