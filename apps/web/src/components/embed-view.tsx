import { useEffect, useRef, useState } from "react";

import { embedAddress, embedReadyMatches, type DisplayBlock } from "../lib/view-spec.js";

const NOTE = "text-[11.5px] text-ink-3 [overflow-wrap:anywhere]";

// SPIKE: a page on another origin draws this block. It is sent the values the
// view description names and nothing else, and the only thing this page takes
// from it is the sign that it is ready. Nothing it sends is read as content.
export function EmbedView({ block }: { block: Extract<DisplayBlock, { kind: "embed" }> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(block);
  latest.current = block;
  const [failed, setFailed] = useState(false);
  const [address] = useState(() => embedAddress(block.src, document.documentElement.classList.contains("dark") ? "dark" : "light"));
  // A page on this app's own origin would run with the reader's session.
  const usable = address !== null && address.origin !== window.location.origin;

  const send = () => {
    const { message, sendAs, origin } = latest.current;
    frame.current?.contentWindow?.postMessage(sendAs === "json-text" ? JSON.stringify(message) : message, origin);
  };

  useEffect(() => {
    if (!usable || block.ready === null) return;
    let answered = false;
    const onMessage = (event: MessageEvent) => {
      const { ready, origin } = latest.current;
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== origin) return;
      if (ready && embedReadyMatches(ready, event.data)) { answered = true; send(); }
    };
    window.addEventListener("message", onMessage);
    const timeout = window.setTimeout(() => { if (!answered) setFailed(true); }, 20_000);
    return () => { window.removeEventListener("message", onMessage); window.clearTimeout(timeout); };
  }, [usable]); // eslint-disable-line react-hooks/exhaustive-deps

  return <section className="min-w-0 space-y-2" data-testid="embed-view">
    <h3 className="text-[13px] font-semibold [overflow-wrap:anywhere]">{block.title}</h3>
    <p className={NOTE}>
      A page served from {block.origin} draws this. Rubrist sends it what is recorded at {block.paths.join(", ")} and nothing else from the case.
      {block.caption ? ` ${block.caption}` : ""}
    </p>
    {!usable ? <p className="text-[12px] text-signal">This view names a page that cannot be shown here.</p>
      : failed ? <p className="text-[12px] text-signal">The page did not answer, so nothing is drawn. Use the recorded evidence below.</p> : (
        <iframe
          ref={frame}
          title={block.title}
          src={address.href}
          sandbox="allow-scripts allow-same-origin"
          allow=""
          referrerPolicy="no-referrer"
          onLoad={block.ready === null ? send : undefined}
          className="block w-full rounded-sm border border-rule-soft bg-card-2"
          style={{ height: block.height }}
        />
      )}
  </section>;
}
