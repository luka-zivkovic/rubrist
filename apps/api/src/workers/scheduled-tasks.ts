export interface ScheduledTask {
  stop(): void | Promise<void>;
}

/**
 * Stop every scheduled task and wait for each in-flight pass. One failed stop
 * is logged and counted; it never skips the others or the queue and storage
 * drain that follows.
 */
export async function stopScheduledTasks(tasks: readonly ScheduledTask[]): Promise<number> {
  const results = await Promise.allSettled(tasks.map(async (task) => task.stop()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  for (const failure of failures) console.error("Failed to stop a scheduled Rubrist task:", failure.reason);
  return failures.length;
}
