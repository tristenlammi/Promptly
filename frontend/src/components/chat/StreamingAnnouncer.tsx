import { useEffect, useRef, useState } from "react";

/**
 * Visually-hidden polite live region that announces when a reply starts
 * and finishes streaming. Screen-reader users get a "responding…" /
 * "response ready" cue without every streamed token being read aloud
 * (which an `aria-live` region over the bubble itself would do).
 */
export function StreamingAnnouncer({ streaming }: { streaming: boolean }) {
  const [status, setStatus] = useState("");
  const prev = useRef(streaming);

  useEffect(() => {
    if (streaming && !prev.current) setStatus("Promptly is responding…");
    else if (!streaming && prev.current) setStatus("Response ready.");
    prev.current = streaming;
  }, [streaming]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {status}
    </div>
  );
}
