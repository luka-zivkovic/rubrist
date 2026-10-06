import { afterEach, expect, it, vi } from 'vitest';
import type { Queue } from '@rubrist/queue';
import { registerBinaryCalibrationWorker } from '../src/binary-calibration/worker.js';
import type { BinaryCalibrationExecutionRepository } from '../src/binary-calibration/repository.js';
import { stagedShutdown } from '../src/shutdown.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
/** Like pg-boss, sends fail once the queue has stopped. No provider is ever reached. */
async function fixture() {
  vi.useFakeTimers();
  const order: string[] = [];
  let closed = false;
  const queue = {
    work: vi.fn(async () => {}),
    send: vi.fn(async (_name: string, data: { runId: string }) => {
      if (closed) throw new Error('Cannot use a pool after calling end on the pool');
      order.push(`send:${data.runId}`);
      return data.runId;
    }),
    stop: vi.fn(async () => { order.push('queue:stop'); closed = true; })
  };
  const pass = deferred<string[]>();
  const listRunnableRunIds = vi.fn<(limit: number) => Promise<string[]>>()
    .mockResolvedValueOnce([])
    .mockImplementation(() => pass.promise);
  const executeProvider = vi.fn();
  const orchestrator = await registerBinaryCalibrationWorker(
    queue as unknown as Queue,
    { listRunnableRunIds } as unknown as BinaryCalibrationExecutionRepository,
    executeProvider,
    { discoveryIntervalMs: 1_000 }
  );
  await vi.advanceTimersByTimeAsync(1_000);
  expect(listRunnableRunIds).toHaveBeenCalledTimes(2);
  return { order, queue, pass, listRunnableRunIds, executeProvider, orchestrator };
}

it('drains a delayed discovery pass before the staged shutdown closes the queue', async () => {
  const { order, queue, pass, listRunnableRunIds, executeProvider, orchestrator } = await fixture();
  const shutdown = stagedShutdown({
    closeServer: async () => {},
    pollers: [orchestrator],
    stopQueue: () => queue.stop(),
    closeStorage: [],
    log: () => {}
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(queue.stop).not.toHaveBeenCalled();
  pass.resolve(['run-1', 'run-2']);
  expect(await shutdown).toBe(true);
  expect(order).toEqual(['send:run-1', 'send:run-2', 'queue:stop']);
  // Future discovery is disabled: no timer pass and no direct pass after stop.
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(orchestrator.discover()).resolves.toBe(0);
  expect(listRunnableRunIds).toHaveBeenCalledTimes(2);
  expect(executeProvider).not.toHaveBeenCalled();
});

it('drains a failing timer discovery pass without a second log or a rejected stop', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { queue, pass, listRunnableRunIds, executeProvider, orchestrator } = await fixture();
  let stopped = false;
  const stop = orchestrator.stop().then(() => { stopped = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(stopped).toBe(false);
  pass.reject(new Error('private repository detail'));
  await expect(stop).resolves.toBeUndefined();
  // The timer's catch is the single, detail-free failure log.
  expect(errors).toHaveBeenCalledTimes(1);
  expect(errors).toHaveBeenCalledWith('binary calibration discovery failed');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(listRunnableRunIds).toHaveBeenCalledTimes(2);
  expect(queue.send).not.toHaveBeenCalled();
  expect(executeProvider).not.toHaveBeenCalled();
});

it('lets a direct discovery caller observe the failure while stop still resolves', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { pass, orchestrator } = await fixture();
  const direct = orchestrator.discover();
  const stop = orchestrator.stop();
  pass.reject(new Error('synthetic discovery failure'));
  await expect(direct).rejects.toThrow('synthetic discovery failure');
  await expect(stop).resolves.toBeUndefined();
  expect(errors).toHaveBeenCalledWith('binary calibration discovery failed');
});
