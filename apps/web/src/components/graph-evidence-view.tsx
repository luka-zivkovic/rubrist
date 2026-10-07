import { useEffect, useRef, useState } from "react";

import { evidenceText } from "../lib/trace-evidence.js";
import type { DrawnGraph, GraphNode } from "../lib/view-spec.js";

const W = 176, H = 64, PAD = 24, FLAG = 16;
const PRE = "max-h-[220px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-mono text-[11.5px] leading-[1.55] text-ink";
const EYEBROW = "mb-1 mt-2.5 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3";
const FLAG_TEXT = "font-mono text-[9.5px] uppercase tracking-[0.08em] text-signal";

function plural(count: number, one: string, many: string) { return `${count} ${count === 1 ? one : many}`; }

function nodeState(node: GraphNode): string {
  if (node.runs.length === 0) return "no recorded step";
  if (node.runs.some(run => run.isError)) return "error";
  return node.runs.length > 1 ? `ran ×${node.runs.length}` : "ran";
}

// SPIKE: Rubrist's own drawing of a declared graph view. Every value is
// rendered as text; the recorded evidence view below stays the source of record.
export function GraphEvidenceView({ graph, evaluatorFailingStep }: { graph: DrawnGraph; evaluatorFailingStep: number | null }) {
  const named = graph.nodes.find(node => node.runs.some(run => run.index === evaluatorFailingStep));
  const [selectedId, setSelectedId] = useState<string | null>((named ?? graph.nodes.find(node => node.runs.length > 0))?.id ?? null);
  const canvas = useRef<HTMLDivElement>(null);

  const minX = Math.min(...graph.nodes.map(node => node.x)), minY = Math.min(...graph.nodes.map(node => node.y));
  const placed = new Map(graph.nodes.map(node => [node.id, { left: node.x - minX + PAD, top: node.y - minY + PAD + FLAG }]));
  const width = Math.max(...[...placed.values()].map(point => point.left)) + W + PAD;
  const height = Math.max(...[...placed.values()].map(point => point.top)) + H + PAD;
  const selected = graph.nodes.find(node => node.id === selectedId) ?? null;
  const idle = graph.nodes.filter(node => node.runs.length === 0).length;
  const recorded = graph.nodes.reduce((total, node) => total + node.runs.length, 0) + graph.orphans.length;

  // Bring the first selection into view by scrolling the graph alone.
  useEffect(() => {
    const point = selectedId === null ? undefined : placed.get(selectedId);
    if (canvas.current && point) canvas.current.scrollLeft = point.left + W / 2 - canvas.current.clientWidth / 2;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="min-w-0 space-y-3" data-testid="graph-evidence-view">
    <div>
      {graph.title ? <h3 className="text-[13px] font-semibold [overflow-wrap:anywhere]">{graph.title}</h3> : null}
      <p className="text-[11.5px] text-ink-3">
        {plural(graph.nodes.length, "node", "nodes")} in the recorded graph · {plural(recorded, "recorded step", "recorded steps")} · {plural(idle, "node", "nodes")} without a recorded step
      </p>
    </div>
    <div ref={canvas} className="overflow-x-auto rounded-sm border border-rule-soft bg-card-2">
      <div className="relative" style={{ width, height }} role="group" aria-label={graph.title ? `Graph: ${graph.title}` : "Graph"}>
        <svg className="absolute inset-0" width={width} height={height} aria-hidden="true">
          {graph.edges.map((edge, index) => {
            const from = placed.get(edge.source)!, to = placed.get(edge.target)!;
            const x1 = from.left + W, y1 = from.top + (edge.port === null ? H / 2 : H * (edge.port + 1) / (edge.ports + 1)), x2 = to.left, y2 = to.top + H / 2;
            const bend = Math.max(30, Math.abs(x2 - x1) / 2);
            const ran = graph.nodes.some(node => node.id === edge.source && node.runs.length > 0)
              && graph.nodes.some(node => node.id === edge.target && node.runs.length > 0);
            return <g key={index}>
              <path d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} fill="none" strokeWidth={1.5}
                className={ran ? "stroke-ink-2" : "stroke-ink-3"} strokeDasharray={ran ? undefined : "4 4"} />
              {edge.port !== null && edge.ports > 1 ? <text x={x1 + 6} y={y1 - 4} className="fill-ink-3 font-mono text-[10px]">out {edge.port}</text> : null}
            </g>;
          })}
        </svg>
        {graph.nodes.map(node => {
          const failed = node.runs.some(run => run.isError);
          const failing = node.runs.some(run => run.index === evaluatorFailingStep);
          const numbers = node.runs.map(run => `#${run.index}`).join(" ");
          const tone = failed || failing ? "border-2 border-signal bg-signal-wash"
            : node.runs.length > 0 ? "border border-ink-2 bg-card" : "border border-dashed border-rule-strong bg-card-2";
          return <button key={node.id} type="button" aria-pressed={node.id === selectedId} onClick={() => setSelectedId(node.id)}
            style={{ ...placed.get(node.id)!, width: W, height: H }}
            className={`absolute flex cursor-pointer flex-col justify-center rounded-sm px-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${tone} ${node.id === selectedId ? "ring-2 ring-ink" : ""}`}>
            {failing ? <span className={`absolute -top-4 left-0 whitespace-nowrap ${FLAG_TEXT}`}>evaluator: failing step</span> : null}
            <span className="truncate text-[12.5px] font-semibold text-ink" title={node.label}>{node.label}</span>
            {node.caption ? <span className="truncate font-mono text-[10px] text-ink-3" title={node.caption}>{node.caption}</span> : null}
            <span className="truncate font-mono text-[10px] text-ink-3">{numbers ? `${numbers} · ` : ""}{nodeState(node)}</span>
          </button>;
        })}
      </div>
    </div>
    <p className="text-[11.5px] text-ink-3">
      Solid outline: a recorded step names the node. Dashed: none does. A solid line joins two nodes that both have recorded steps; the case does not record which line the data took. Select a node for its recorded input and output.
    </p>
    {selected ? <div className="rounded-sm border border-rule-soft p-3" aria-live="polite">
      <h4 className="text-[12.5px] font-semibold [overflow-wrap:anywhere]">{selected.label}{selected.caption ? ` · ${selected.caption}` : ""}</h4>
      {selected.runs.length === 0 ? <p className="mt-1 text-[12px] text-ink-3">No recorded step names this node. That is what was recorded, not proof the node did not run.</p> : null}
      {selected.runs.map(run => <div key={run.index} className="mt-2 border-t border-rule-soft pt-2 first:border-0 first:pt-0">
        <p className="text-[11.5px] text-ink-3">
          Step #{run.index} · {run.status ?? "status not recorded"}{run.durationMs !== null ? ` · ${run.durationMs} ms` : ""}
        </p>
        {run.index === evaluatorFailingStep ? <p className={FLAG_TEXT}>evaluator: failing step</p> : null}
        {run.error !== undefined ? <><p className={EYEBROW}>Recorded error</p><pre className={PRE}>{evidenceText(run.error)}</pre></> : null}
        <p className={EYEBROW}>Input</p><pre className={PRE}>{evidenceText(run.step.input)}</pre>
        <p className={EYEBROW}>Output</p><pre className={PRE}>{evidenceText(run.step.output)}</pre>
      </div>)}
    </div> : null}
    {graph.orphans.length > 0 ? <p className="text-[12px] text-ink-3 [overflow-wrap:anywhere]">
      {plural(graph.orphans.length, "recorded step names", "recorded steps name")} no node in this graph and {graph.orphans.length === 1 ? "is" : "are"} not drawn: {graph.orphans.map(orphan => `#${orphan.index} ${orphan.name ?? "unnamed step"}`).join(", ")}. Read {graph.orphans.length === 1 ? "it" : "them"} in the recorded evidence below.
    </p> : null}
    {graph.undrawnEdges > 0 ? <p className="text-[12px] text-ink-3">
      {plural(graph.undrawnEdges, "recorded connection names", "recorded connections name")} a node this graph does not have and {graph.undrawnEdges === 1 ? "is" : "are"} not drawn.
    </p> : null}
  </div>;
}
