/**
 * Detection only for the monotonic command clock (M4 limitation): a persisted
 * clock far ahead of host time means one faulty forward sample is holding
 * every new timestamp. Nothing here rewinds, caps or rejects writes.
 *
 * The tolerance keeps ordinary millisecond scheduling and NTP slew silent; a
 * drift above it is diagnosed once per episode, so frequent readiness probes
 * cannot repeat the warning.
 */
export const COMMAND_CLOCK_DRIFT_TOLERANCE_MS = 60_000;

export function createCommandClockDriftMonitor(
  log: (message: string) => void = message => console.warn(message),
  toleranceMs = COMMAND_CLOCK_DRIFT_TOLERANCE_MS
) {
  let ahead = false;
  return {
    /** `aheadMs` is the persisted clock minus host time; non-numbers are ignored. */
    observe(aheadMs: unknown): void {
      if (typeof aheadMs !== 'number' || !Number.isFinite(aheadMs)) return;
      if (aheadMs > toleranceMs) {
        if (ahead) return;
        ahead = true;
        log(`rubrist.storage.clock: the persisted SQLite command clock is about ${Math.round(aheadMs / 1000)} s ahead of host time `
          + `(diagnostic tolerance ${toleranceMs / 1000} s). New records keep that later time until host time catches up. `
          + 'Investigate host time synchronization and pause writes; do not edit the database. Startup and readiness are unaffected.');
      } else if (ahead && aheadMs <= 0) {
        ahead = false;
        log('rubrist.storage.clock: host time has caught up with the persisted SQLite command clock.');
      }
    }
  };
}
