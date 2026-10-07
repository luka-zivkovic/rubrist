import { useEffect, useId, useState } from "react";

import type { DisplayBlock, DisplayField, DisplayItem, DisplayValue } from "../lib/view-spec.js";
import { GraphEvidenceView } from "./graph-evidence-view.js";
import { EmbedView } from "./embed-view.js";

const TEXT = "whitespace-pre-wrap [overflow-wrap:anywhere] text-[13px] leading-6 text-ink-2";
const CODE = "max-h-[360px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-mono text-[11.5px] leading-[1.55] text-ink";
const EYEBROW = "mb-1 font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3";
const BADGE = "inline-flex max-w-full items-center gap-1 rounded-sm border border-rule-soft px-1.5 py-px font-mono text-[10.5px] text-ink-2";
const NOTE = "mt-1 text-[11px] text-ink-3";

type Cited = { list: string; index: number } | null;

function Value({ value }: { value: Exclude<DisplayValue, { kind: "missing" }> }) {
  return <>
    {value.kind === "code" ? <pre className={CODE}>{value.text}</pre>
      : <p className={TEXT}>{value.text.length > 0 ? value.text : <em>Empty text</em>}</p>}
    {value.note ? <p className={NOTE}>{value.note}</p> : null}
  </>;
}

function Fields({ fields, onFollow }: { fields: DisplayField[]; onFollow: (target: NonNullable<Cited>) => void }) {
  const badges = fields.flatMap(field => "value" in field && field.value.kind === "badge" ? [{ label: field.label, text: field.value.text }] : []);
  return <div className="space-y-3">
    {badges.length > 0 ? <div className="flex flex-wrap gap-1.5">
      {badges.map(badge => <span key={badge.label} className={BADGE}><span className="text-ink-3">{badge.label}</span><span className="truncate">{badge.text}</span></span>)}
    </div> : null}
    {fields.map(field => "links" in field ? <div key={field.label}>
      <p className={EYEBROW}>{field.label} · {field.links.length}</p>
      {field.links.length === 0 ? <p className="text-[12.5px] text-ink-3">Not recorded</p> : <ul className="space-y-1">
        {field.links.map((link, position) => <li key={position} className="font-mono text-[11.5px] [overflow-wrap:anywhere]">
          {link.index !== null
            ? <button type="button" className="cursor-pointer text-left text-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              onClick={() => onFollow({ list: link.list, index: link.index! })}>{link.text}</button>
            : <span className="text-ink-3">{link.text} · no single matching item in this case</span>}
        </li>)}
      </ul>}
    </div> : field.value.kind === "badge" ? null : <div key={field.label}>
      <p className={EYEBROW}>{field.label}</p>
      {field.value.kind === "missing" ? <p className="text-[12.5px] text-ink-3">Not recorded</p> : <Value value={field.value} />}
    </div>)}
  </div>;
}

function List({ id, title, items, prefix, cited, onFollow }: {
  id: string; title: string; items: DisplayItem[]; prefix: string; cited: Cited; onFollow: (target: NonNullable<Cited>) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const target = cited?.list === id ? cited.index : null;
  // Following a link opens the item and moves to it; it changes nothing saved.
  useEffect(() => {
    if (target === null) return;
    setOpen(current => new Set(current).add(target));
    const element = document.getElementById(`${prefix}-${id}-${target}`);
    element?.scrollIntoView({ block: "nearest" });
    element?.focus({ preventScroll: true });
  }, [cited]); // eslint-disable-line react-hooks/exhaustive-deps

  return <section aria-label={title} className="space-y-2">
    <h3 className="text-[13px] font-semibold">{title} · {items.length}</h3>
    {items.map((item, index) => {
      const isOpen = open.has(index), isCited = target === index;
      return <div key={index} id={`${prefix}-${id}-${index}`} tabIndex={-1} data-list-item={index}
        className={`min-w-0 rounded-sm border focus-visible:outline-2 focus-visible:outline-offset-2 ${isCited ? "border-amber-600 bg-amber-50 dark:border-amber-400 dark:bg-amber-950/30" : "border-rule-soft"}`}>
        <button type="button" aria-expanded={isOpen} className="flex w-full cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-card-2"
          onClick={() => setOpen(current => { const next = new Set(current); if (!next.delete(index)) next.add(index); return next; })}>
          <span className="font-mono text-[10.5px] text-ink-3">{isOpen ? "▾" : "▸"}</span>
          <span className="font-mono text-[11px] text-ink-3">#{index}</span>
          <span className="text-[12.5px] font-medium text-ink [overflow-wrap:anywhere]">{item.heading ?? "unnamed item"}</span>
          {item.badges.map(badge => <span key={badge.label} className={BADGE}><span className="text-ink-3">{badge.label}</span><span className="truncate">{badge.text}</span></span>)}
        </button>
        {isCited ? <p className="px-3 pb-2 text-[11px] font-medium text-amber-900 dark:text-amber-200">Cited by the recorded output · check that it supports the claim</p> : null}
        {isOpen ? <div className="border-t border-rule-soft px-3 py-2.5"><Fields fields={item.fields} onFollow={onFollow} /></div> : null}
      </div>;
    })}
  </section>;
}

// SPIKE: Rubrist's own drawing of a declared view. Every value is rendered as
// text; the recorded evidence view below stays the source of record.
export function DeclaredEvidenceView({ blocks, evaluatorFailingStep }: { blocks: DisplayBlock[]; evaluatorFailingStep: number | null }) {
  const prefix = useId();
  const [cited, setCited] = useState<Cited>(null);
  // A new object each time, so following the same link twice moves there again.
  const follow = (target: NonNullable<Cited>) => setCited({ ...target });
  return <div className="min-w-0 space-y-5" data-testid="declared-evidence-view">
    {blocks.map((block, index) => {
      if (block.kind === "graph") {
        return "problem" in block.graph
          ? <p key={index} className="text-[12px] text-ink-3 [overflow-wrap:anywhere]">{block.graph.problem} Use the recorded evidence below.</p>
          : <GraphEvidenceView key={index} graph={block.graph} evaluatorFailingStep={evaluatorFailingStep} />;
      }
      if (block.kind === "embed") return <EmbedView key={index} block={block} />;
      if (block.kind === "problem") {
        return <section key={index}>
          {block.title ? <h3 className="text-[13px] font-semibold">{block.title}</h3> : null}
          <p className="text-[12px] text-ink-3 [overflow-wrap:anywhere]">{block.problem} Use the recorded evidence below.</p>
        </section>;
      }
      if (block.kind === "fields") {
        return <section key={index} className="space-y-2">
          {block.title ? <h3 className="text-[13px] font-semibold">{block.title}</h3> : null}
          <Fields fields={block.fields} onFollow={follow} />
        </section>;
      }
      return <List key={index} id={block.id} title={block.title} items={block.items} prefix={prefix} cited={cited} onFollow={follow} />;
    })}
  </div>;
}
