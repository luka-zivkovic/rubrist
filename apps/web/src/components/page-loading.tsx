// Loading placeholders carry no invented values and stay hidden from assistive
// technology; the one status label describes the pending read.
export function PageLoading({ title, shape = "detail" }: { title: string; shape?: "detail" | "list" | "editor" }) {
  return (
    <section role="status" aria-busy="true" aria-label={title} className="fadeUp max-w-[1200px]">
      <h1 className="mb-6 font-serif text-2xl">{title}</h1>
      <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
        <div className="h-4 w-2/3 rounded-sm bg-rule-soft" />
        {shape === "list" ? Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex gap-5 rounded-sm border border-rule-soft p-5">
            <div className="h-4 w-1/5 rounded-sm bg-rule-soft" /><div className="h-4 w-1/2 rounded-sm bg-rule-soft" />
          </div>
        )) : <>
          <div className="grid grid-cols-2 gap-4"><div className="h-24 rounded-sm bg-rule-soft" /><div className="h-24 rounded-sm bg-rule-soft" /></div>
          <div className={`rounded-sm border border-rule-soft p-6 ${shape === "editor" ? "h-64" : "h-40"}`}>
            <div className="mb-4 h-4 w-1/3 rounded-sm bg-rule-soft" /><div className="h-4 w-3/4 rounded-sm bg-rule-soft" />
          </div>
        </>}
      </div>
    </section>
  );
}
