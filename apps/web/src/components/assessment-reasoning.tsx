import type { ReactNode } from "react";

// Link only explicit, resolvable source message numbers. The prose is unchanged;
// a link is navigation, not a claim that the evaluator's interpretation is true.
export function AssessmentReasoning({ text, sourceIndices, targetPrefix, onInspect }: {
  text: string; sourceIndices: number[]; targetPrefix: string; onInspect: (index: number) => void;
}) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\bmessage\s+(0|[1-9]\d*)\b(?!\.\d|\s*[-–—]\s*\d|\s+(?:and|to)\s+\d)/gi)) {
    const index = Number(match[1]);
    if (!sourceIndices.includes(index)) continue;
    parts.push(text.slice(cursor, match.index));
    parts.push(<a key={match.index} href={`#${targetPrefix}-${index}`} onClick={event => {
      event.preventDefault(); onInspect(index);
    }} className="rounded-sm font-medium text-blue-800 underline decoration-blue-400 underline-offset-3 focus-visible:outline-2 focus-visible:outline-offset-2 dark:text-blue-200">{match[0]}</a>);
    cursor = match.index + match[0].length;
  }
  parts.push(text.slice(cursor));
  return <span className="whitespace-pre-wrap">{parts}</span>;
}
