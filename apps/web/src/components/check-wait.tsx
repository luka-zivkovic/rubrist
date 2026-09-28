import { useEffect, useState } from "react";

export const LONG_CHECK_WAIT_MS = 120_000;

export function checkWaitElapsed(createdAt: string, now: number): { label: string; long: boolean } {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return { label: "Save time unavailable", long: false };
  const elapsed = Math.max(0, now - created);
  const seconds = Math.floor(elapsed / 1000);
  const label = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 3600)} hr`;
  return { label: `Version saved ${label} ago`, long: elapsed >= LONG_CHECK_WAIT_MS };
}

// Creation is a known timestamp. It is not the provider start time: an
// unrecorded regression result can still be queued or unavailable.
export function CheckWait({ createdAt, stopped = false }: { createdAt: string; stopped?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (stopped) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [createdAt, stopped]);
  const elapsed = checkWaitElapsed(createdAt, now);
  return (
    <div className="mt-2 text-[11.5px] leading-5 text-ink-3">
      <span>{elapsed.label}</span>
      {elapsed.long && !stopped ? <p role="status" className="mt-1">
        Still waiting for the recorded check result. The worker may be queued or processing it.
        {" "}It is safe to leave and return through Version history; this page keeps checking.
      </p> : null}
    </div>
  );
}
