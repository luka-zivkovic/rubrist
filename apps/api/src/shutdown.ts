/**
 * Staged API shutdown. HTTP and pollers drain first because in-flight requests
 * and poller ticks still enqueue jobs; the queue closes its send path only
 * after them. Every later stage runs even when an earlier one fails, and the
 * first stage is time-boxed so the queue keeps part of the overall deadline.
 */
export interface ShutdownStages {
  closeServer(): Promise<void>;
  pollers: ReadonlyArray<{ stop(): void | Promise<void> }>;
  stopQueue?: (() => Promise<void>) | undefined;
  closeStorage: ReadonlyArray<() => Promise<void>>;
  /** Stage-one budget; the caller's forced-exit timer bounds the whole shutdown. */
  drainMs?: number;
  log?: (message: string, error?: unknown) => void;
}

export async function stagedShutdown(stages: ShutdownStages): Promise<boolean> {
  const log = stages.log ?? ((message: string, error?: unknown) => console.error(message, ...(error === undefined ? [] : [error])));
  let clean = true;
  const drain = Promise.allSettled([
    stages.closeServer(),
    ...stages.pollers.map(poller => Promise.resolve().then(() => poller.stop()))
  ]);
  let timer: NodeJS.Timeout | undefined;
  const drained = await Promise.race([
    drain,
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), stages.drainMs ?? 15_000); })
  ]).finally(() => clearTimeout(timer));
  if (drained === null) {
    clean = false;
    log('HTTP and poller drain deadline reached; stopping the queue with work still in flight');
  } else {
    for (const result of drained) {
      if (result.status === 'rejected') { clean = false; log('Shutdown drain step failed', result.reason); }
    }
  }
  for (const step of [stages.stopQueue, ...stages.closeStorage]) {
    if (!step) continue;
    try { await step(); } catch (error) { clean = false; log('Shutdown cleanup step failed', error); }
  }
  return clean;
}
