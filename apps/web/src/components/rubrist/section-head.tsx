import * as React from "react";
import { Eyebrow } from "./eyebrow";
import { cn } from "@/lib/utils";

export interface SectionHeadProps {
  headingAs?: "h1" | "h2";
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  when?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}

export function SectionHead({ eyebrow, title, sub, when, right, className, headingAs: Heading = "h1" }: SectionHeadProps) {
  return (
    <div className={cn("mb-5 min-w-0", className)}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <div className="mt-2 flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <Heading className="min-w-0 max-w-full break-words font-serif text-[24px] font-medium leading-[1.08] tracking-[-0.02em]">{title}</Heading>
        {when || right ? (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            {when ? <div className="font-mono text-[10.5px] text-ink-3">{when}</div> : null}
            {right}
          </div>
        ) : null}
      </div>
      <div aria-hidden="true" className="mt-3 h-px w-full bg-rule" />
      {sub ? (
        <div className="mt-3 max-w-[70ch] text-[13.5px] leading-[1.55] text-ink-3">{sub}</div>
      ) : null}
    </div>
  );
}
