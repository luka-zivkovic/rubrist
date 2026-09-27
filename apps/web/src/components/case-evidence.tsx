import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { evidenceClaim } from "../lib/recorded-evaluation.js";

export function CaseEvidence({ input, output }: { input: unknown; output: unknown }) {
  const content = evidenceClaim(input, output);
  if (!content) return null;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Claim and supplied evidence</CardTitle>
          <CardDescription>Read the claim against the complete source text below.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <section>
          <h3 className="mb-2 text-[13px] font-medium">Claim to evaluate</h3>
          <p className="whitespace-pre-wrap break-words text-[14px] leading-6">{content.claim}</p>
        </section>
        {content.context !== undefined ? (
          <section>
            <h3 className="mb-2 text-[13px] font-medium">Context for resolving references</h3>
            <p className="mb-2 text-[12px] text-ink-3">This may identify entities or pronouns; it is not additional supporting evidence.</p>
            <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-ink-2">{content.context}</p>
          </section>
        ) : null}
        <section>
          <h3 className="mb-2 text-[13px] font-medium">Supplied evidence · {content.evidence.length} entries</h3>
          {content.evidence.length === 0 ? <p>No evidence was supplied.</p> : (
            <ol className="max-h-[640px] list-decimal space-y-2 overflow-auto pl-8 pr-3 text-[13px] leading-6">
              {content.evidence.map((text, index) => <li key={index} className="whitespace-pre-wrap break-words pl-1">{text}</li>)}
            </ol>
          )}
        </section>
        <details className="border-t border-rule-soft pt-3">
          <summary className="cursor-pointer text-[12px] text-ink-3">Raw input and output</summary>
          <pre className="mt-2 max-h-[420px] overflow-auto whitespace-pre-wrap break-words text-[11.5px]">{JSON.stringify({ input, output }, null, 2)}</pre>
        </details>
      </CardContent>
    </Card>
  );
}
