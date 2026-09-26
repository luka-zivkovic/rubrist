import * as React from "react";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyShell } from "./empty-shell";

// A page whose data could not load. It says what failed and offers Retry; it
// never reads as empty or not found.
export function PageLoadError({
  eyebrow,
  title,
  message,
  onRetry,
  back
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  message: React.ReactNode;
  onRetry: () => void;
  back?: React.ReactNode;
}) {
  return (
    <EmptyShell
      eyebrow={eyebrow}
      title={title}
      body={<span className="break-words">{message}</span>}
      primary={
        <Button variant="primary" onClick={onRetry}>
          <RefreshCcw /> Retry
        </Button>
      }
      secondary={back}
    />
  );
}

// One section of a page whose data could not load. The rest of the page keeps
// working, and the failure is shown where the data would have been.
export function SectionLoadError({
  title,
  message,
  onRetry,
  className
}: {
  title: React.ReactNode;
  message: React.ReactNode;
  onRetry: () => void;
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
        <span className="ml-2 break-words text-ink-3">{message}</span>
      </div>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        <RefreshCcw /> Retry
      </Button>
    </div>
  );
}
