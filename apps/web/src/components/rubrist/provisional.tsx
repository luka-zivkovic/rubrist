import * as React from "react";
import { Ban } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Provisional atoms — verdicts produced under an unreviewed starter rubric
// wear a dashed badge and nothing syncs back until sign-off.
export function ProvChip({ className }: { className?: string }) {
  return (
    <Badge variant="provisional" className={className}>
      Provisional
    </Badge>
  );
}

export interface ProvBannerProps {
  text: React.ReactNode;
  cta?: React.ReactNode;
  cta2?: React.ReactNode;
  className?: string;
}

export function ProvBanner({ text, cta, cta2, className }: ProvBannerProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-sm border border-dashed border-gold bg-gold-tint px-3.5 py-2.5 text-[12.5px] text-ink-2",
        className
      )}
    >
      <span className="grid place-items-center text-gold">
        <Ban className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 basis-[calc(100%-2rem)] flex-1 sm:basis-0">{text}</span>
      {cta2 || cta ? <div className="flex max-w-full flex-wrap items-center gap-2 [&_button]:h-auto [&_button]:min-h-8 [&_button]:max-w-full [&_button]:whitespace-normal [&_a]:h-auto [&_a]:min-h-8 [&_a]:max-w-full [&_a]:whitespace-normal">{cta2}{cta}</div> : null}
    </div>
  );
}
