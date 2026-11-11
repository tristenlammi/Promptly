import {
  ArrowUp, ArrowUpLeft, ArrowUpRight, CornerUpLeft, CornerUpRight, Flag, MapPin, Merge, Redo2, RotateCw, Ship, Undo2,
} from "lucide-react";
import QRCode from "qrcode";
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { Skeleton } from "@/components/shared/Skeleton";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** Small pieces the Maps panels share: switches, choices, the phone sheet,
 *  delete-with-Undo, turn icons and "Send to my phone". */

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ---- Switch and choices (in place of the browser's own tick boxes and drop-downs) ----

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (on: boolean) => void; label?: string; disabled?: boolean; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-[var(--accent-strong)]" : "bg-[var(--border)]"}`}
    >
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}

/** A switch with its words: the whole row is the target. */
export function SwitchRow({ checked, onChange, disabled, children, className }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onChange(!checked)}
      onKeyDown={(e) => {
        if (disabled || (e.key !== " " && e.key !== "Enter")) return;
        e.preventDefault();
        onChange(!checked);
      }}
      className={`flex min-h-10 cursor-pointer items-center justify-between gap-3 ${disabled ? "cursor-default opacity-60" : ""} ${className ?? ""}`}
    >
      <span className="min-w-0">{children}</span>
      <span aria-hidden="true" className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-[var(--accent-strong)]" : "bg-[var(--border)]"}`}>
        <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[22px]" : "translate-x-0.5"}`} />
      </span>
    </div>
  );
}

/** Pick one of a few: a row of pills. */
export function Choice<V extends string | number>({ value, onChange, options, label, className }: {
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`flex flex-wrap gap-1.5 ${className ?? ""}`}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`inline-flex h-10 items-center rounded-full border px-3 text-xs md:h-8 ${o.value === value ? "border-transparent bg-[var(--accent-strong)] font-medium text-white" : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- Delete with Undo ----

const UNDO_MS = 10_000;

interface Removal {
  timer: number;
  toastId: string;
  run: () => Promise<unknown>;
  finish: () => Promise<void>;
}

/**
 * Hide a row straight away and delete it for real once the Undo toast has
 * gone. Undo within those ten seconds puts it back exactly as it was, since
 * nothing was deleted yet. Leaving the map deletes whatever is still waiting.
 */
export function usePendingRemovals() {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const waiting = useRef(new Map<string, Removal>());
  const alive = useRef(true);

  const show = useCallback((key: string) => {
    if (!alive.current) return;
    setHidden((s) => {
      if (!s.has(key)) return s;
      const next = new Set(s);
      next.delete(key);
      return next;
    });
  }, []);

  const remove = useCallback((key: string, o: { message: string; run: () => Promise<unknown>; done?: () => Promise<unknown> | void; failed: string }) => {
    if (waiting.current.has(key)) return;
    setHidden((s) => new Set(s).add(key));
    const finish = async () => {
      const row = waiting.current.get(key);
      if (!row) return;
      waiting.current.delete(key);
      window.clearTimeout(row.timer);
      toast.dismiss(row.toastId);
      try {
        await o.run();
        await o.done?.();
      } catch (e) {
        toast.error(apiErrorMessage(e, o.failed));
      } finally {
        show(key);
      }
    };
    const toastId = toast.success(o.message, {
      duration: UNDO_MS,
      action: {
        label: "Undo",
        onClick: () => {
          const row = waiting.current.get(key);
          if (!row) return;
          window.clearTimeout(row.timer);
          waiting.current.delete(key);
          show(key);
        },
      },
    });
    waiting.current.set(key, { timer: window.setTimeout(() => void finish(), UNDO_MS), toastId, run: o.run, finish });
  }, [show]);

  /** Do the waiting deletes for this key (or every key starting with it) now:
   *  for when the next thing you do would otherwise be undone by them. */
  const settle = useCallback(async (match: string) => {
    const rows = [...waiting.current].filter(([key]) => key === match || key.startsWith(`${match}:`));
    await Promise.all(rows.map(([, row]) => row.finish()));
  }, []);

  // Leaving (another page, or closing the tab): do what's still waiting now.
  useEffect(() => {
    alive.current = true;
    const flush = () => {
      for (const [key, row] of [...waiting.current]) {
        window.clearTimeout(row.timer);
        waiting.current.delete(key);
        toast.dismiss(row.toastId);
        void row.run().catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      alive.current = false;
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  return { hidden, remove, settle };
}

// ---- Distances ----

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---- Turn icons for the step list (the routing engine's manoeuvre numbers) ----

type IconType = typeof ArrowUp;
const TURN: Record<number, IconType> = {
  1: MapPin, 2: MapPin, 3: MapPin,
  4: Flag, 5: Flag, 6: Flag,
  9: ArrowUpRight, 10: CornerUpRight, 11: CornerUpRight, 12: Redo2,
  13: Undo2, 14: CornerUpLeft, 15: CornerUpLeft, 16: ArrowUpLeft,
  18: ArrowUpRight, 19: ArrowUpLeft, 20: ArrowUpRight, 21: ArrowUpLeft,
  23: ArrowUpRight, 24: ArrowUpLeft,
  25: Merge, 37: Merge, 38: Merge,
  26: RotateCw, 27: RotateCw,
  28: Ship, 29: Ship,
};

export function StepIcon({ type }: { type: number }) {
  const Icon = TURN[type] ?? ArrowUp;
  return <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />;
}

// ---- Loading rows ----

export function RouteSkeleton() {
  return (
    <div role="status" aria-label="Finding the way" className="space-y-3 px-4 pt-3">
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-44 max-w-full" />
          </div>
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
    </div>
  );
}

export function RowsSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3 px-4 py-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Panels slide as you move between them ----

/** Its contents ease in from the side whenever ``name`` changes: from the right
 *  going deeper, from the left coming back to the start. */
export function PanelSlide({ name, back, children }: { name: string; back: boolean; children: React.ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const node = el.current;
    if (!node || reducedMotion() || typeof node.animate !== "function") return;
    node.animate(
      [{ opacity: 0, transform: `translateX(${back ? -14 : 14}px)` }, { opacity: 1, transform: "translateX(0)" }],
      { duration: 180, easing: "ease-out" },
    );
    // Only when the panel changes.
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={el}>{children}</div>;
}

// ---- The phone's bottom sheet: drag it between three heights ----

/** 0: just a peek, 1: half the screen, 2: nearly all of it. */
export type SheetSnap = 0 | 1 | 2;
const SHEET_PEEK = 84;
const SHEET_TOP_GAP = 80;
const SHEET_HEIGHT: Record<SheetSnap, string> = { 0: `${SHEET_PEEK}px`, 1: "50%", 2: `calc(100% - ${SHEET_TOP_GAP}px)` };

export const PhoneSheet = forwardRef<HTMLDivElement, {
  snap: SheetSnap;
  onSnap: (s: SheetSnap) => void;
  /** Size to what's inside instead (typing with the keyboard up), no taller than this. */
  fit?: string | null;
  bottom: number;
  children: React.ReactNode;
}>(function PhoneSheet({ snap, onSnap, fit, bottom, children }, ref) {
  const box = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ y: number; h: number; moved: boolean; lastY: number; lastT: number; speed: number } | null>(null);
  const dragged = useRef(false);

  const heights = (): [number, number, number] => {
    const all = box.current?.parentElement?.clientHeight ?? window.innerHeight;
    return [SHEET_PEEK, Math.round(all * 0.5), Math.max(SHEET_PEEK, all - SHEET_TOP_GAP)];
  };

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (fit || !box.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: box.current.offsetHeight, moved: false, lastY: e.clientY, lastT: e.timeStamp, speed: 0 };
  };
  const move = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    const node = box.current;
    if (!d || !node) return;
    if (!d.moved && Math.abs(e.clientY - d.y) < 5) return;
    if (!d.moved) {
      d.moved = true;
      node.style.transition = "none";
    }
    const [low, , high] = heights();
    node.style.height = `${Math.min(high, Math.max(low, d.h + (d.y - e.clientY)))}px`;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.speed = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
  };
  const up = () => {
    const d = drag.current;
    const node = box.current;
    drag.current = null;
    if (!d || !node || !d.moved) return;
    dragged.current = true;
    const rests = heights();
    const now = node.offsetHeight;
    let to = ([0, 1, 2] as SheetSnap[]).reduce((best, s) => (Math.abs(rests[s] - now) < Math.abs(rests[best] - now) ? s : best), 1 as SheetSnap);
    // A quick flick goes one step that way, however far it got.
    if (Math.abs(d.speed) > 0.45) to = (d.speed < 0 ? Math.min(2, snap + 1) : Math.max(0, snap - 1)) as SheetSnap;
    node.style.transition = "";
    node.style.height = SHEET_HEIGHT[to];
    onSnap(to);
  };

  return (
    <div
      ref={(node) => {
        box.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      style={fit ? { bottom, height: "auto", maxHeight: fit } : { bottom, height: SHEET_HEIGHT[snap] }}
      className="absolute inset-x-0 z-20 flex flex-col rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface)] shadow-[0_-4px_20px_rgba(0,0,0,0.15)] transition-[height] duration-200 ease-out"
    >
      <button
        type="button"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onClick={() => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          if (!fit) onSnap(snap === 1 ? 2 : 1);
        }}
        onKeyDown={(e) => {
          if (fit) return;
          if (e.key === "ArrowUp") onSnap(Math.min(2, snap + 1) as SheetSnap);
          else if (e.key === "ArrowDown") onSnap(Math.max(0, snap - 1) as SheetSnap);
          else return;
          e.preventDefault();
        }}
        aria-label={snap === 2 ? "Make the panel smaller" : "Make the panel bigger. Drag to resize"}
        className="flex h-7 w-full shrink-0 cursor-grab touch-none items-center justify-center"
      >
        <span aria-hidden="true" className="h-1 w-10 rounded-full bg-[var(--border)]" />
      </button>
      <div className={`min-h-0 flex-1 pb-[env(safe-area-inset-bottom)] ${!fit && snap === 0 ? "overflow-hidden" : "overflow-y-auto"}`}>{children}</div>
    </div>
  );
});

// ---- Send to my phone ----

function QrImage({ text }: { text: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { margin: 1, width: 220, errorCorrectionLevel: "M" })
      .then((url) => live && setSrc(url))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [text]);
  return src ? <img src={src} alt="A code to scan with your phone's camera" width={220} height={220} className="rounded-lg bg-white p-1" /> : <Skeleton className="h-[220px] w-[220px]" />;
}

export async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Couldn't copy that. Your browser didn't allow it.");
  }
}

/** Turn-by-turn runs on the phone: a code to scan, and a link to copy, that open this trip there. */
export function SendToPhone({ link, fromHere, onClose }: { link: string | null; /** The trip starts wherever the phone is: it opens as a place. */ fromHere?: boolean; onClose: () => void }) {
  return (
    <Modal
      open={!!link}
      onClose={onClose}
      title="Send to my phone"
      description="Turn-by-turn directions run in the Promptly app on your Android phone."
      widthClass="max-w-sm"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      {link && (
        <div className="flex flex-col items-center gap-3 text-center">
          <QrImage text={link} />
          <p className="text-sm text-[var(--text-muted)]">Point your phone's camera at the code. {fromHere ? "The place opens in Promptly on your phone: tap Directions, then Start." : "This trip opens in Promptly on your phone: then tap Start."} Your phone needs to be signed in to Promptly.</p>
          <Button onClick={() => void copyText(link, "Link copied")}>Copy the link instead</Button>
        </div>
      )}
    </Modal>
  );
}
