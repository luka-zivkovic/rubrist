/** One in-flight probe even under concurrent health requests or a stuck worker. */
export function createReadiness(probe: () => Promise<boolean>, timeoutMs = 2000) {
  let stopping = false;
  let pending: Promise<boolean> | undefined;
  return {
    stop() { stopping = true; },
    async check(): Promise<boolean> {
      if (stopping) return false;
      if (!pending) {
        const current = Promise.resolve().then(probe).catch(() => false).finally(() => {
          if (pending === current) pending = undefined;
        });
        pending = current;
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        const ready = await Promise.race([pending, new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        })]);
        return ready && !stopping;
      } finally { clearTimeout(timer); }
    }
  };
}
