import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";

import { linksApi } from "@/api/links";

/**
 * Rich link previews for the note editor. A single delegated hover listener
 * on the editor container watches for external ``<a>`` links; hovering one
 * (briefly) pops a card with the site's favicon, title, description and OG
 * image — fetched from the SSRF-safe ``/api/links/unfurl`` endpoint and
 * cached per-URL by react-query. In-app wiki links (``item=…``) are skipped —
 * those already open the item preview modal.
 */
export function LinkHoverPreview({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const [target, setTarget] = useState<{ href: string; rect: DOMRect } | null>(
    null
  );
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const overCard = useRef(false);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const cancelShow = () => {
      if (showTimer.current) {
        window.clearTimeout(showTimer.current);
        showTimer.current = null;
      }
    };
    const cancelHide = () => {
      if (hideTimer.current) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };

    const onOver = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest(
        "a[href]"
      ) as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.href;
      if (!/^https?:\/\//i.test(href)) return;
      if (href.includes("item=")) return; // in-app wiki link → its own modal
      cancelHide();
      cancelShow();
      const rect = a.getBoundingClientRect();
      showTimer.current = window.setTimeout(
        () => setTarget({ href, rect }),
        350
      );
    };

    const onOut = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest("a[href]");
      if (!a) return;
      cancelShow();
      hideTimer.current = window.setTimeout(() => {
        if (!overCard.current) setTarget(null);
      }, 250);
    };

    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseout", onOut);
    return () => {
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", onOut);
      cancelShow();
      cancelHide();
    };
  }, [containerRef]);

  if (!target) return null;
  return createPortal(
    <LinkCard
      href={target.href}
      rect={target.rect}
      onEnter={() => {
        overCard.current = true;
        if (hideTimer.current) {
          window.clearTimeout(hideTimer.current);
          hideTimer.current = null;
        }
      }}
      onLeave={() => {
        overCard.current = false;
        setTarget(null);
      }}
    />,
    document.body
  );
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

function LinkCard({
  href,
  rect,
  onEnter,
  onLeave,
}: {
  href: string;
  rect: DOMRect;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const [faviconOk, setFaviconOk] = useState(true);
  const { data, isLoading } = useQuery({
    queryKey: ["link-preview", href],
    queryFn: () => linksApi.unfurl(href),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const host = hostOf(href);
  const WIDTH = 320;
  const left = Math.max(
    8,
    Math.min(rect.left, window.innerWidth - WIDTH - 8)
  );
  // Prefer below the link; flip above if it would run off the bottom.
  const belowTop = rect.bottom + 8;
  const top = belowTop + 220 > window.innerHeight ? undefined : belowTop;
  const bottom =
    top === undefined ? window.innerHeight - rect.top + 8 : undefined;

  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={() =>
        window.open(href, "_blank", "noopener,noreferrer")
      }
      title="Open in a new tab"
      style={{
        position: "fixed",
        left,
        top,
        bottom,
        width: WIDTH,
        zIndex: 70,
      }}
      className="cursor-pointer overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl transition hover:border-[var(--accent)]/50"
    >
      {data?.image && (
        <img
          src={data.image}
          alt=""
          className="h-32 w-full object-cover"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}
      <div className="p-3">
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          {data?.favicon && faviconOk ? (
            <img
              src={data.favicon}
              alt=""
              className="h-3.5 w-3.5 shrink-0 rounded-sm"
              onError={() => setFaviconOk(false)}
            />
          ) : (
            <Globe className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">{data?.site_name || host}</span>
        </div>
        <div className="mt-1 line-clamp-2 text-sm font-medium text-[var(--text)]">
          {isLoading ? "Loading…" : data?.title || host}
        </div>
        {data?.description && (
          <div className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
            {data.description}
          </div>
        )}
      </div>
    </div>
  );
}
