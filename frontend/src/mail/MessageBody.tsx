import { MapPin } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { PlacePreviewSheet } from "@/components/PlacePreviewSheet";
import { findAddresses, splitAddresses } from "@/lib/addresses";
import { useMapsReady } from "@/maps/useMapsReady";

import { mailApi } from "./api";

const FRAME_STYLE = `body{margin:0;padding:2px;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#2B2622;background:#fff;word-break:break-word}
img{max-width:100%;height:auto}table{max-width:100%}a{color:#B85C38}blockquote{margin:0 0 0 12px;padding-left:12px;border-left:2px solid #E5DDD5;color:#6B635B}
img[data-remote-src]{display:none}`;

/** What an email looks like, in a page of its own. It's a sandbox with no scripts,
 *  and its own rules forbid fetching anything, so a message can't run code or tell
 *  anyone you opened it until you say so. */
export function MessageBody({ html, text, remoteImages, clipped }: { html: string; text: string; remoteImages: boolean; clipped?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [pictures, setPictures] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(false);
  // Street addresses in the email open a small map first. Found in the
  // email's plain words, out here: the sandboxed page itself is never touched.
  const [place, setPlace] = useState<string | null>(null);
  const addresses = useMemo(() => findAddresses(text), [text]);
  const mapsReady = useMapsReady(addresses.length > 0);
  const places = mapsReady ? addresses : [];

  const page = useMemo(() => {
    let body = html;
    if (pictures) {
      body = body.replace(/data-remote-src=(["'])(.*?)\1/gi, (whole, _q: string, url: string) => {
        const data = pictures[url.replaceAll("&amp;", "&")];
        return data ? `src="${data}"` : whole;
      });
    }
    const rules = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${rules}"><base target="_blank"><style>${FRAME_STYLE}</style></head><body>${body}</body></html>`;
  }, [html, pictures]);

  const measure = () => {
    const doc = frame.current?.contentDocument;
    if (doc?.documentElement) setHeight(Math.max(60, doc.documentElement.scrollHeight + 4));
  };

  useEffect(() => {
    const t = window.setTimeout(measure, 400);
    return () => window.clearTimeout(t);
  }, [page]);

  if (!html) {
    return (
      <div>
        {clipped && <p className="mb-2 text-xs text-[var(--text-muted)]">This email couldn't be shown safely with its formatting, so it's shown as plain text.</p>}
        <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-[var(--text)]">
          {places.length === 0
            ? text
            : splitAddresses(text).map((part, i) =>
                part.address ? (
                  <button key={i} type="button" onClick={() => setPlace(part.text.replace(/\s+/g, " ").trim())} title="See it on a map" className="inline rounded text-left text-[var(--accent-text)] underline decoration-dotted underline-offset-2 hover:decoration-solid">
                    {part.text}
                  </button>
                ) : (
                  part.text
                ),
              )}
        </div>
        <PlacePreviewSheet address={place} onClose={() => setPlace(null)} />
      </div>
    );
  }

  const showImages = async () => {
    const urls = [...html.matchAll(/data-remote-src=(["'])(.*?)\1/gi)].map((m) => m[2].replaceAll("&amp;", "&")).slice(0, 50);
    setLoading(true);
    try {
      setPictures(await mailApi.images(urls));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      {remoteImages && !pictures && (
        <button type="button" onClick={() => void showImages()} disabled={loading} className="mb-2 rounded-lg bg-[var(--hover)] px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-60">
          {loading ? "Loading pictures…" : "Pictures are hidden so senders can't tell you've opened this. Show them"}
        </button>
      )}
      <div className="overflow-hidden rounded-xl bg-white p-3">
        {/* Scripts stay off, so same-origin only lets us read its height. */}
        <iframe ref={frame} title="Email" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={page} onLoad={measure} style={{ height }} className="w-full border-0" />
      </div>
      {places.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2" aria-label="Places in this email">
          {places.map((address) => (
            <button key={address} type="button" onClick={() => setPlace(address)} title="See it on a map" className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[var(--hover)] px-2.5 py-1.5 text-xs text-[var(--text)] hover:text-[var(--accent-text)]">
              <MapPin className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{address}</span>
            </button>
          ))}
        </div>
      )}
      <PlacePreviewSheet address={place} onClose={() => setPlace(null)} />
    </div>
  );
}
