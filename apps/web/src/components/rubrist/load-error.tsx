import * as React from "react";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LoadFailure } from "@/lib/load-error";
import { cn } from "@/lib/utils";
import { EmptyShell } from "./empty-shell";

// A page whose data could not load. It says what failed and offers Retry when
// retrying can work; it never reads as empty or not found.
export function PageLoadError({
  eyebrow,
  title,
  failure,
  onRetry,
  back
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  failure: LoadFailure;
  onRetry: () => void;
  back?: React.ReactNode;
}) {
  return (
    <EmptyShell
      eyebrow={eyebrow}
      title={title}
      body={<span className="break-words">{failure.message}</span>}
      primary={
        failure.retryable ? (
          <Button variant="primary" onClick={onRetry}>
            <RefreshCcw /> Retry
          </Button>
        ) : null
      }
      secondary={back}
    />
  );
}

// One section of a page whose data could not load. The rest of the page keeps
// working, the failure is shown where the data would have been, and it stays
// in place while a retry is in flight.
export function SectionLoadError({
  title,
  failure,
  onRetry,
  retrying = false,
  className
}: {
  title: React.ReactNode;
  failure: LoadFailure;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-sm border border-signal-tint bg-signal-wash px-3 py-2.5 text-[12.5px]",
        className
      )}
    >
      <div className="min-w-0 flex-1">
        <span className="font-medium text-signal">{title}</span>
        <span className="ml-2 break-words text-ink-3">{failure.message}</span>
      </div>
      {failure.retryable ? (
        <Button variant="ghost" size="sm" onClick={onRetry} disabled={retrying}>
          <RefreshCcw /> {retrying ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
    </div>
  );
}
