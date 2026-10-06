import {afterEach, expect, it, vi} from 'vitest';
import {stagedShutdown} from '../src/shutdown.js';

afterEach(() => {vi.useRealTimers();});
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** pg-boss closes its own pool in stop(); a later send fails. */
function closingQueue(order: string[]) {
  let closed = false;
  return {
    async send(name: string) {
      if (closed) throw new Error('Cannot use a pool after calling end on the pool');
      order.push(`send:${name}`);
      return name;
    },
    async stop() { order.push('queue:stop'); closed = true; }
  };
}
function delayedEnqueuers(queue: ReturnType<typeof closingQueue>, order: string[]) {
  const sends: Promise<unknown>[] = [];
  const closeServer = async () => {
    // An in-flight HTTP request enqueues after shutdown began.
    await delay(40); sends.push(queue.send('eval.run')); await sends.at(-1); order.push('http:closed');
  };
  const tick = (async () => { await delay(20); sends.push(queue.send('langsmith.import')); await sends.at(-1); })();
  return {closeServer, poller: {stop: async () => { await tick; order.push('poller:stopped'); }}, sends};
}

it('keeps the queue send path open until delayed HTTP and poller enqueues finish', async () => {
  const order: string[] = [];
  const queue = closingQueue(order);
  const {closeServer, poller, sends} = delayedEnqueuers(queue, order);
  const storage = vi.fn(async () => { order.push('storage:closed'); });
  expect(await stagedShutdown({closeServer, pollers: [poller], stopQueue: () => queue.stop(), closeStorage: [storage], log: () => {}})).toBe(true);
  await expect(Promise.all(sends)).resolves.toEqual(['langsmith.import', 'eval.run']);
  expect(order).toEqual(['send:langsmith.import', 'poller:stopped', 'send:eval.run', 'http:closed', 'queue:stop', 'storage:closed']);
});

it('detects the concurrent shutdown regression this staging prevents', async () => {
  const order: string[] = [];
  const queue = closingQueue(order);
  const {closeServer, poller} = delayedEnqueuers(queue, order);
  // The previous Milestone 5 ordering stopped the queue beside the drains.
  await expect(Promise.all([closeServer(), queue.stop(), poller.stop()])).rejects.toThrow('pool');
});

it('continues to the queue and storage when a poller stop rejects', async () => {
  const order: string[] = [];
  const log = vi.fn();
  const clean = await stagedShutdown({
    closeServer: async () => { order.push('http:closed'); },
    pollers: [{stop: async () => { throw new Error('synthetic poller failure'); }}, {stop: () => { order.push('sync:stopped'); }}],
    stopQueue: async () => { order.push('queue:stop'); },
    closeStorage: [async () => { throw new Error('synthetic pool failure'); }, async () => { order.push('sqlite:closed'); }],
    log
  });
  expect(clean).toBe(false);
  expect(order).toEqual(['http:closed', 'sync:stopped', 'queue:stop', 'sqlite:closed']);
  expect(log).toHaveBeenCalledWith('Shutdown drain step failed', expect.objectContaining({message: 'synthetic poller failure'}));
  expect(log).toHaveBeenCalledWith('Shutdown cleanup step failed', expect.objectContaining({message: 'synthetic pool failure'}));
});

it('bounds a stuck HTTP drain so queue and storage still get the remaining budget', async () => {
  vi.useFakeTimers();
  const order: string[] = [];
  const log = vi.fn();
  const done = stagedShutdown({
    closeServer: () => new Promise<void>(() => {}),
    pollers: [],
    stopQueue: async () => { order.push('queue:stop'); throw new Error('synthetic queue failure'); },
    closeStorage: [async () => { order.push('storage:closed'); }],
    drainMs: 15_000,
    log
  });
  await vi.advanceTimersByTimeAsync(14_999);
  expect(order).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(await done).toBe(false);
  expect(order).toEqual(['queue:stop', 'storage:closed']);
  expect(log).toHaveBeenCalledWith('HTTP and poller drain deadline reached; stopping the queue with work still in flight');
});
