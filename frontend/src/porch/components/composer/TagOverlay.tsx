import { RowsSkeleton } from "../ui";
import { Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState, type RefObject } from "react";

import type { PorchUser } from "@/api/porch";
import { Sheet, TextInput } from "@/items/ui";
import { cn } from "@/utils/cn";

import { PorchAvatar } from "../ui";
import type { DraftTag } from "./model";

/** Where the picture really is inside a box that fits it in (object-contain). */
function useContentBox(box: RefObject<HTMLElement | null>, key: string) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // A passive effect: the box's ref is attached by then (a layout effect
  // here runs before the parent's ref is set).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const pic = el.querySelector<HTMLImageElement | HTMLCanvasElement | HTMLVideoElement>("img, canvas, video");
      if (!pic) return setRect(null);
      const iw = pic instanceof HTMLImageElement ? pic.naturalWidth : pic instanceof HTMLVideoElement ? pic.videoWidth : pic.width;
      const ih = pic instanceof HTMLImageElement ? pic.naturalHeight : pic instanceof HTMLVideoElement ? pic.videoHeight : pic.height;
      const bw = el.clientWidth;
      const bh = el.clientHeight;
      if (!iw || !ih || !bw || !bh) return setRect(null);
      const s = Math.min(bw / iw, bh / ih);
      const w = iw * s;
      const h = ih * s;
      setRect({ left: (bw - w) / 2, top: (bh - h) / 2, width: w, height: h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The picture arrives (or is redrawn) after the box: measure again.
    const mo = new MutationObserver(measure);
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["width", "height", "src"] });
    el.addEventListener("load", measure, true);
    const t = window.setInterval(measure, 700);
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("load", measure, true);
      window.clearInterval(t);
    };
  }, [box, key]);
  return rect;
}

/**
 * Tagging people on the photo being arranged: in tag mode, tap someone in
 * the photo and pick who it is (only people who'll see the post). Tags show
 * with names; × takes one off. Face suggestions (when both of you turned
 * them on) show as "Sam?" to tap. Keyboard: "Tag someone" puts the tag in
 * the middle.
 */
export function TagOverlay({
  box,
  pickKey,
  tags,
  onChange,
  tagging,
  audience,
  audienceReady,
  suggestions,
  addOpen,
  setAddOpen,
}: {
  box: RefObject<HTMLElement | null>;
  pickKey: string;
  tags: DraftTag[];
  onChange: (tags: DraftTag[]) => void;
  tagging: boolean;
  audience: PorchUser[];
  audienceReady: boolean;
  suggestions: { user: PorchUser; x: number; y: number }[];
  /** The people list, opened from outside ("Tag someone"). */
  addOpen: boolean;
  setAddOpen: (v: boolean) => void;
}) {
  const rect = useContentBox(box, pickKey);
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (addOpen) setFilter("");
  }, [addOpen]);
  const inAudience = useMemo(() => new Set(audience.map((u) => u.id)), [audience]);
  const taken = new Set(tags.map((t) => t.user.id));
  const choices = audience.filter(
    (u) => !taken.has(u.id) && (!filter.trim() || u.name.toLowerCase().includes(filter.trim().toLowerCase()) || u.username.toLowerCase().includes(filter.trim().toLowerCase())),
  );
  const offered = suggestions.filter((s) => !taken.has(s.user.id));

  const add = (u: PorchUser, at: { x: number; y: number }) => {
    onChange([...tags, { user: u, x: Math.round(at.x * 1e4) / 1e4, y: Math.round(at.y * 1e4) / 1e4 }]);
  };
  const close = () => {
    setAddOpen(false);
    setSpot(null);
  };

  return (
    <>
      {rect && (
        <div
          className={cn("absolute", tagging && "cursor-crosshair")}
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          onClick={(e) => {
            if (!tagging || e.target !== e.currentTarget) return;
            const r = e.currentTarget.getBoundingClientRect();
            setSpot({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
            setAddOpen(true);
          }}
          data-tag-surface
        >
          <ul aria-label="Tagged" className="contents">
            {tags.map((t) => {
              const can = !audienceReady || inAudience.has(t.user.id);
              return (
                <li key={t.user.id} className="absolute" style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%` }}>
                  <span className="absolute left-0 top-0 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black/60" aria-hidden />
                  <span
                    className={cn(
                      "absolute left-0 top-0 flex -translate-x-1/2 translate-y-2 items-center gap-1 whitespace-nowrap rounded-lg py-0.5 pl-2 pr-0.5 text-xs font-semibold text-white shadow-[var(--shadow-md)]",
                      can ? "bg-black/75" : "border border-dashed border-white/70 bg-black/45",
                    )}
                  >
                    {t.user.name}
                    {t.status === "pending" && <span className="font-normal opacity-90">· waiting</span>}
                    <button
                      type="button"
                      aria-label={`Untag ${t.user.name}`}
                      onClick={() => onChange(tags.filter((x) => x.user.id !== t.user.id))}
                      className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </span>
                </li>
              );
            })}
            {offered.map((s) => (
              <li key={`s-${s.user.id}`} className="absolute" style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%` }}>
                <button
                  type="button"
                  onClick={() => add(s.user, s)}
                  aria-label={`Tag ${s.user.name} (suggested from their face)`}
                  className="absolute left-0 top-0 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-lg border border-dashed border-white bg-black/45 px-2 py-1 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <Sparkles className="h-3 w-3" aria-hidden /> {s.user.name}?
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tagging && (
        <p className="pointer-events-none absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full bg-black/65 px-3 py-1 text-xs font-medium text-white">Tap someone in the photo</p>
      )}

      <Sheet open={addOpen} onClose={close} title="Who's this?" size="sm">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-[var(--text-muted)]">Only people who'll see this post can be tagged. They're asked first, and the tag shows once they say yes.</p>
          {audience.length > 6 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
              <TextInput type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find someone" aria-label="Find someone to tag" className="pl-9" data-autofocus />
            </div>
          )}
          {!audienceReady ? (
            <RowsSkeleton rows={3} />
          ) : choices.length === 0 ? (
            <p className="py-4 text-center text-sm text-[var(--text-muted)]">
              {audience.length ? "Nobody else to tag." : "Nobody else will see this post yet, so there's no one to tag. Pick its groups in the next step."}
            </p>
          ) : (
            <ul className="-mx-2 flex max-h-[50dvh] flex-col overflow-y-auto">
              {choices.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => {
                      add(u, spot ?? { x: 0.5, y: 0.5 });
                      close();
                    }}
                    className="flex min-h-[48px] w-full items-center gap-3 rounded-xl px-2 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
                  >
                    <PorchAvatar user={u} size={32} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium text-[var(--text)]">{u.name}</span>
                      <span className="truncate text-xs text-[var(--text-muted)]">@{u.username}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Sheet>
    </>
  );
}
