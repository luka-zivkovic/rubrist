import * as React from "react";
import { Ban, Star } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GOLDEN_GATE_RECOMMENDED } from "@rubrist/shared";
import { GATE_LABEL, isGateState, type GateState } from "@/lib/regression-gate";

export { gateStateForVersion, type GateState } from "@/lib/regression-gate";

const GATE_VARIANT: Record<GateState, BadgeProps["variant"]> = {
  clean: "pass",
  blocked: "fail",
  error: "fail",
  override: "ambig",
  inactive: "provisional",
  first: "outline",
  running: "outline",
  unrecorded: "outline",
  unavailable: "outline",
  loading: "outline"
};

export function GateChip({ state, title, className }: { state: GateState; title?: string; className?: string }) {
  // An unknown state reads as unavailable, never as clean.
  const known = isGateState(state) ? state : "unavailable";
  return (
    <Badge variant={GATE_VARIANT[known]} className={cn("normal-case", className)} title={title}>
      {GATE_LABEL[known]}
    </Badge>
  );
}

// The strip that sits in the Skill editor: what saving will trigger.
// One explicit state, computed by the caller — never reconstructed from
// boolean ordering. "armed" wins over "no-evidence" on purpose: a project
// whose traces were pruned after promotion still has a live golden set, and
// the gate genuinely runs against it.
export type GateStripState = "no-evidence" | "unarmed" | "armed";

export interface GateStripProps {
  state: GateStripState;
  goldenSize: number;
  // Drives vocabulary only: bench projects add labeled examples and review
  // disagreements; tracing projects import traces and work the exceptions
  // queue. Mode-blind copy next to a mode-aware CTA reads as two products.
  mode: "bench" | "tracing";
  onStartEvidence: () => void;
  onOpenExceptions: () => void;
  onOpenGolden: () => void;
  className?: string;
}

// The one banner shell all three states share: tone stripe, icon, body, action.
function GateBanner({
  tone,
  body,
  action,
  className
}: {
  tone: "signal" | "gold";
  body: React.ReactNode;
  action: React.ReactNode;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 border border-rule border-l-2 bg-card px-3.5 py-2.5 text-[12.5px] text-ink-2",
        tone === "gold" ? "border-l-gold" : "border-l-signal",
        className
      )}
    >
      <span className={cn("mt-0.5 grid place-items-center", tone === "gold" ? "text-gold" : "text-signal")}>
        {tone === "gold" ? <Star className="h-[13px] w-[13px]" /> : <Ban className="h-[13px] w-[13px]" />}
      </span>
      <div className="flex-1">{body}</div>
      {action}
    </div>
  );
}

function GateProgress({ goldenSize }: { goldenSize: number }) {
  const recommended = GOLDEN_GATE_RECOMMENDED;
  const progress = Math.min(goldenSize, recommended);
  const pct = Math.round((progress / recommended) * 100);
  return (
    <div className="mt-2.5 max-w-[520px]" aria-label={`${progress} of ${recommended} recommended golden cases`}>
      <div className="mb-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
        <span>Known-failure evidence</span>
        <span>{progress}/{recommended}{goldenSize > recommended ? ` · ${goldenSize} total` : ""}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-paper-3">
        <div
          className={cn("h-full transition-[width]", goldenSize > 0 ? "bg-gold" : "bg-signal")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-[10.5px] text-ink-4">
        {goldenSize === 0
          ? "The first human-promoted case enables evaluator reference checks."
          : goldenSize < recommended
            ? `Reference checks enabled · promote ${recommended - goldenSize} more for the recommended starting set.`
            : "Recommended starting set reached · keep adding evaluator boundary cases."}
      </div>
    </div>
  );
}

export function GateStrip({ state, goldenSize, mode, onStartEvidence, onOpenExceptions, onOpenGolden, className }: GateStripProps) {
  const bench = mode === "bench";
  if (state === "no-evidence") {
    return (
      <GateBanner
        tone="signal"
        className={className}
        body={
          <>
            <b>Build evaluator reference-check evidence.</b>
            <ol className="mt-2 grid grid-cols-3 gap-2 text-[11.5px] leading-[1.45]">
              <li className="rounded-sm bg-paper-2 px-2.5 py-2">
                <b>1.</b> {bench ? "Add labeled examples so the judge produces verdicts." : "Submit runs so the judge produces verdicts."}
              </li>
              <li className="rounded-sm bg-paper-2 px-2.5 py-2">
                <b>2.</b> {bench ? "Review disagreements and adjudicate them with human labels." : "Adjudicate exceptions with human labels."}
              </li>
              <li className="rounded-sm bg-paper-2 px-2.5 py-2">
                <b>3.</b> Promote agreed cases — the first promotion enables reference checks; aim for {GOLDEN_GATE_RECOMMENDED}+.
              </li>
            </ol>
            <GateProgress goldenSize={goldenSize} />
          </>
        }
        action={
          <Button size="sm" variant="outline" onClick={onStartEvidence}>
            {bench ? "Add examples" : "Import a trace"}
          </Button>
        }
      />
    );
  }
  if (state === "unarmed") {
    return (
      <GateBanner
        tone="signal"
        className={className}
        body={
          <>
            <b>Evaluator reference check inactive.</b> There are no promoted reference cases yet, so a new
            evaluator version has no known-failure comparison. Promote your first agreed case to enable the check —
            aim for {GOLDEN_GATE_RECOMMENDED}+ before treating the result as strong evidence.
            <GateProgress goldenSize={goldenSize} />
          </>
        }
        action={
          <Button size="sm" variant="outline" onClick={onOpenExceptions}>
            {bench ? "Review disagreements" : "Open exceptions"}
          </Button>
        }
      />
    );
  }
  return (
    <GateBanner
      tone="gold"
      className={className}
      body={
        <>
          <b>Evaluator reference check enabled.</b> Saving re-judges all {goldenSize} promoted reference cases
          and records the outcome. Reference disagreements require review or a recorded override reason.
          Check Version history for the current default; a reference check does not establish general accuracy.
          <GateProgress goldenSize={goldenSize} />
        </>
      }
      action={
        <Button size="sm" variant="ghost" onClick={onOpenGolden}>
          See the {goldenSize} cases
        </Button>
      }
    />
  );
}
