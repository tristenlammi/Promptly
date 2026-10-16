import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FlipHorizontal2, RotateCcw, RotateCw, Undo2, X } from "lucide-react";

import { filesApi } from "@/api/files";
import { photosApi, type EditOps, type PhotoItem } from "@/api/photos";
import { Button } from "@/components/shared/Button";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/** The photo editor (PH-7): crop, rotate, flip, brightness, contrast and
 *  saturation — saved as an edit beside the original, which is never
 *  changed (Revert goes back to it). The preview here is the original's,
 *  drawn turned on a canvas, with the adjustments as a CSS filter — close
 *  to what the server makes. */

const NONE: EditOps = { rotate: 0, flip: false, crop: null, brightness: 0, contrast: 0, saturation: 0 };
type Crop = NonNullable<EditOps["crop"]>;
type Handle = "move" | "nw" | "ne" | "sw" | "se";
const ASPECTS: { label: string; ratio: number | "original" | null }[] = [
  { label: "Free", ratio: null },
  { label: "Original", ratio: "original" },
  { label: "Square", ratio: 1 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "3:2", ratio: 3 / 2 },
  { label: "16:9", ratio: 16 / 9 },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function PhotoEditor({ photo, onClose, onSaved }: { photo: PhotoItem; onClose: () => void; onSaved: (item: PhotoItem | null) => void }) {
  const [ops, setOps] = useState<EditOps>(NONE);
  const [had, setHad] = useState(false);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tab, setTab] = useState<"crop" | "adjust">("crop");
  const [aspect, setAspect] = useState<number | "original" | null>(null);
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // The original's preview and the edit so far.
  useEffect(() => {
    let off = false;
    void Promise.all([filesApi.signedUrls(photo.id), photosApi.getEdit(photo.id)])
      .then(([urls, edit]) => {
        if (off) return;
        if (edit.ops) {
          setOps({ ...NONE, ...edit.ops });
          setHad(true);
        }
        const src = urls.source ?? urls.preview;
        if (!src) throw new Error("not ready");
        const im = new Image();
        im.onload = () => !off && setImg(im);
        im.src = src;
      })
      .catch((e) => {
        toast.error(apiErrorMessage(e, "This photo can't be edited yet."));
        closeRef.current();
      });
    return () => {
      off = true;
    };
  }, [photo.id]);

  // The picture, turned and flipped, as large as fits.
  const turned = ops.rotate === 90 || ops.rotate === 270;
  const nat = img ? { w: turned ? img.naturalHeight : img.naturalWidth, h: turned ? img.naturalWidth : img.naturalHeight } : null;
  useEffect(() => {
    const el = stage.current;
    if (!el || !nat) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const s = Math.min((r.width - 32) / nat.w, (r.height - 32) / nat.h, 1.5);
      setBox({ w: Math.round(nat.w * s), h: Math.round(nat.h * s) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nat?.w, nat?.h]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img || !box.w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(box.w * dpr);
    c.height = Math.round(box.h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2);
    if (ops.flip) ctx.scale(-1, 1);
    ctx.rotate((ops.rotate * Math.PI) / 180);
    const [dw, dh] = turned ? [c.height, c.width] : [c.width, c.height];
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  }, [img, box, ops.rotate, ops.flip, turned]);

  const filter = `brightness(${1 + ops.brightness}) contrast(${1 + ops.contrast}) saturate(${1 + ops.saturation})`;
  const crop: Crop = ops.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const ratioOf = useCallback(
    (a: number | "original" | null): number | null => (a === "original" ? (nat ? nat.w / nat.h : null) : a),
    [nat],
  );

  // A crop of this aspect, as big as fits, centred.
  const fitAspect = (a: number | "original" | null) => {
    setAspect(a);
    const r = ratioOf(a);
    if (!r || !nat) return;
    let w = 1;
    let h = (nat.w / nat.h) / r;
    if (h > 1) {
      w = 1 / h;
      h = 1;
    }
    setOps((o) => ({ ...o, crop: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } }));
  };

  const drag = useRef<{ handle: Handle; x: number; y: number; start: Crop } | null>(null);
  const onDown = (handle: Handle) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { handle, x: e.clientX, y: e.clientY, start: crop };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !box.w) return;
    const dx = (e.clientX - d.x) / box.w;
    const dy = (e.clientY - d.y) / box.h;
    const s = d.start;
    const min = 0.05;
    let next: Crop;
    if (d.handle === "move") {
      next = { ...s, x: clamp(s.x + dx, 0, 1 - s.w), y: clamp(s.y + dy, 0, 1 - s.h) };
    } else {
      let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      if (d.handle.includes("w")) x0 = clamp(x0 + dx, 0, x1 - min);
      if (d.handle.includes("e")) x1 = clamp(x1 + dx, x0 + min, 1);
      if (d.handle.includes("n")) y0 = clamp(y0 + dy, 0, y1 - min);
      if (d.handle.includes("s")) y1 = clamp(y1 + dy, y0 + min, 1);
      const r = ratioOf(aspect);
      if (r && nat) {
        // Keep the shape: the height follows the width.
        const h = ((x1 - x0) * nat.w) / nat.h / r;
        if (d.handle.includes("n")) y0 = clamp(y1 - h, 0, y1 - min);
        else y1 = clamp(y0 + h, y0 + min, 1);
        const w = ((y1 - y0) * nat.h * r) / nat.w;
        if (d.handle.includes("w")) x0 = x1 - w;
        else x1 = x0 + w;
      }
      next = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    setOps((o) => ({ ...o, crop: next }));
  };
  const onUp = () => {
    drag.current = null;
  };

  // The keyboard's way: arrows move the crop (Shift: further), + / − resize
  // it about its centre (keeping a chosen shape).
  const onCropKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const c = crop;
    let next: Crop | null = null;
    if (e.key === "ArrowLeft") next = { ...c, x: clamp(c.x - step, 0, 1 - c.w) };
    else if (e.key === "ArrowRight") next = { ...c, x: clamp(c.x + step, 0, 1 - c.w) };
    else if (e.key === "ArrowUp") next = { ...c, y: clamp(c.y - step, 0, 1 - c.h) };
    else if (e.key === "ArrowDown") next = { ...c, y: clamp(c.y + step, 0, 1 - c.h) };
    else if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") {
      const f = e.key === "+" || e.key === "=" ? 1.05 : 0.95;
      const w = clamp(c.w * f, 0.05, 1);
      const h = clamp(c.h * f, 0.05, 1);
      if ((w >= 1 || h >= 1) && f > 1 && ratioOf(aspect)) return;
      next = { x: clamp(c.x + (c.w - w) / 2, 0, 1 - w), y: clamp(c.y + (c.h - h) / 2, 0, 1 - h), w, h };
    }
    if (next) {
      e.preventDefault();
      setOps((o) => ({ ...o, crop: next }));
    }
  };

  const turn = (by: 90 | -90) =>
    setOps((o) => ({ ...o, rotate: (((o.rotate + by) % 360) + 360) % 360 as EditOps["rotate"], crop: null }));
  const changed = useMemo(() => JSON.stringify(ops) !== JSON.stringify(NONE), [ops]);

  const save = async () => {
    setSaving(true);
    try {
      const out = await photosApi.saveEdit(photo.id, ops);
      toast.success(out.ops ? "Saved — the original is kept." : "Back to the original.");
      onSaved(out.item);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save the edit."));
    } finally {
      setSaving(false);
    }
  };
  const revert = async () => {
    setSaving(true);
    try {
      const out = await photosApi.revertEdit(photo.id);
      toast.success("Back to the original.");
      onSaved(out.item);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't revert it."));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);

  const slider = (key: "brightness" | "contrast" | "saturation", label: string) => (
    <label className="block text-xs">
      <span className="flex justify-between text-white/80">
        {label} <span className="tabular-nums">{Math.round(ops[key] * 100)}</span>
      </span>
      <input type="range" min={-100} max={100} value={Math.round(ops[key] * 100)} aria-label={label}
        onChange={(e) => setOps((o) => ({ ...o, [key]: Number(e.target.value) / 100 }))}
        onDoubleClick={() => setOps((o) => ({ ...o, [key]: 0 }))}
        className="w-full accent-[var(--accent)]" />
    </label>
  );
  const btn = "rounded-full p-2 text-white/90 hover:bg-white/10";

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Edit photo" className="fixed inset-0 z-[70] flex flex-col bg-black text-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" aria-label="Close editor" onClick={onClose} className={btn}>
          <X className="h-5 w-5" />
        </button>
        <span className="flex-1 truncate text-sm font-medium">Edit</span>
        {had && (
          <Button size="sm" variant="ghost" leftIcon={<Undo2 className="h-3.5 w-3.5" />} disabled={saving} onClick={() => void revert()}
            className="text-white hover:bg-white/10">
            Revert to original
          </Button>
        )}
        <Button size="sm" variant="primary" loading={saving} disabled={!changed && !had} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <div ref={stage} className="relative flex min-h-0 flex-1 items-center justify-center" onPointerMove={onMove} onPointerUp={onUp}>
        {!img ? (
          <p className="text-sm text-white/60">Loading…</p>
        ) : (
          <div className="relative" style={{ width: box.w, height: box.h }}>
            {/* The dimming outside the crop stays on the picture. */}
            <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
              {tab === "crop" && (
                <div className="absolute" style={{
                  boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
                  left: crop.x * box.w, top: crop.y * box.h, width: crop.w * box.w, height: crop.h * box.h,
                }} />
              )}
            </div>
            <canvas ref={canvas} style={{ width: box.w, height: box.h, filter }} aria-label="Photo being edited" role="img" />
            {tab === "crop" && (
              <>
                <div
                  role="group"
                  tabIndex={0}
                  aria-label="Crop area — arrow keys move it, + and − resize it"
                  onKeyDown={onCropKey}
                  className="absolute z-20 cursor-move border border-white/90 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  style={{ left: crop.x * box.w, top: crop.y * box.h, width: crop.w * box.w, height: crop.h * box.h }}
                  onPointerDown={onDown("move")}
                >
                  <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
                    {Array.from({ length: 9 }, (_, i) => <span key={i} className="border border-white/20" />)}
                  </div>
                  {(["nw", "ne", "sw", "se"] as const).map((h) => (
                    <span key={h} aria-hidden="true" onPointerDown={onDown(h)}
                      className={cn("absolute h-4 w-4 border-white",
                        h === "nw" && "-left-1 -top-1 cursor-nwse-resize border-l-4 border-t-4",
                        h === "ne" && "-right-1 -top-1 cursor-nesw-resize border-r-4 border-t-4",
                        h === "sw" && "-bottom-1 -left-1 cursor-nesw-resize border-b-4 border-l-4",
                        h === "se" && "-bottom-1 -right-1 cursor-nwse-resize border-b-4 border-r-4")} />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="border-t border-white/10 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2">
        <div className="mb-2 flex justify-center gap-1" role="tablist">
          {(["crop", "adjust"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={cn("rounded-full px-3 py-1 text-xs", tab === t ? "bg-white text-black" : "text-white/80 hover:bg-white/10")}>
              {t === "crop" ? "Crop & rotate" : "Adjust"}
            </button>
          ))}
        </div>
        {tab === "crop" ? (
          <div className="flex flex-wrap items-center justify-center gap-1">
            <button type="button" aria-label="Rotate left" onClick={() => turn(-90)} className={btn}><RotateCcw className="h-5 w-5" /></button>
            <button type="button" aria-label="Rotate right" onClick={() => turn(90)} className={btn}><RotateCw className="h-5 w-5" /></button>
            <button type="button" aria-label="Flip" aria-pressed={ops.flip} onClick={() => setOps((o) => ({ ...o, flip: !o.flip, crop: o.crop && { ...o.crop, x: 1 - o.crop.x - o.crop.w } }))} className={btn}>
              <FlipHorizontal2 className="h-5 w-5" />
            </button>
            <span className="mx-2 h-5 w-px bg-white/20" />
            {ASPECTS.map((a) => (
              <button key={a.label} type="button" aria-pressed={aspect === a.ratio} onClick={() => (a.ratio ? fitAspect(a.ratio) : setAspect(null))}
                className={cn("rounded-full px-2.5 py-1 text-xs", aspect === a.ratio ? "bg-white/20" : "text-white/80 hover:bg-white/10")}>
                {a.label}
              </button>
            ))}
            {ops.crop && (
              <button type="button" onClick={() => setOps((o) => ({ ...o, crop: null }))} className="rounded-full px-2.5 py-1 text-xs text-white/80 hover:bg-white/10">
                No crop
              </button>
            )}
          </div>
        ) : (
          <div className="mx-auto grid max-w-xl gap-2 sm:grid-cols-3">
            {slider("brightness", "Brightness")}
            {slider("contrast", "Contrast")}
            {slider("saturation", "Saturation")}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
