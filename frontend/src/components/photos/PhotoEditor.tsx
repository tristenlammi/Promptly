import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Circle, Copy, Download, FlipHorizontal2, Grid3x3, Highlighter, ImagePlus, Loader2, Minus, MousePointer2, MoveUpRight, Pencil,
  Redo2, RotateCcw, RotateCw, Share2, Smile, Square, Sticker, Trash2, Type, Undo2, X,
} from "lucide-react";

import { filesApi } from "@/api/files";
import { photosApi, type EditOps, type MarkupShape, type MarkupType, type PhotoItem } from "@/api/photos";
import { Button } from "@/components/shared/Button";
import {
  COLORS, EMOJI, HIGHLIGHT_FACTOR, STICKERS, TEXT_FONT, TEXT_SIZES, WIDTHS, drawMarkup, hitTest, itemBox, onStickerLoad,
  shapeBounds, stickerUrl,
} from "@/components/photos/photoMarkup";
import { FILTER_PRESETS, cssFilter, presetOf } from "@/components/photos/filterPresets";
import { ItemButton, Sheet } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/** The photo editor (PH-7): crop, rotate, flip, brightness, contrast,
 *  saturation and markup (pen, highlighter, arrows, shapes, text, blur,
 *  emoji, stickers) — saved as an edit beside the original, which is never
 *  changed (Revert goes back to it); or saved as a new photo beside it;
 *  or copied / shared / downloaded without saving anything. The preview
 *  is the original's, drawn turned on a canvas, with the adjustments as a
 *  CSS filter and the marks drawn on top the way the server draws them. */

const NONE: EditOps = { rotate: 0, flip: false, crop: null, brightness: 0, contrast: 0, saturation: 0, markup: [] };
type Crop = NonNullable<EditOps["crop"]>;
type Handle = "move" | "nw" | "ne" | "sw" | "se";
type Tab = "crop" | "filters" | "adjust" | "markup";
type Tool = "select" | Exclude<MarkupType, "emoji" | "sticker">;
const WHOLE: Crop = { x: 0, y: 0, w: 1, h: 1 };
const ASPECTS: { label: string; ratio: number | "original" | null }[] = [
  { label: "Free", ratio: null },
  { label: "Original", ratio: "original" },
  { label: "Square", ratio: 1 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "3:2", ratio: 3 / 2 },
  { label: "16:9", ratio: 16 / 9 },
];
// Porch's "for this post only" crops (WP-P1.4): the photo as it is, or the
// shapes a feed shows well.
const POST_ASPECTS: { label: string; ratio: number | "original" | null }[] = [
  { label: "Original", ratio: "original" },
  { label: "Square", ratio: 1 },
  { label: "4:5", ratio: 4 / 5 },
  { label: "Free", ratio: null },
];
const TOOLS: { id: Tool; label: string; icon: typeof Pencil }[] = [
  { id: "select", label: "Select", icon: MousePointer2 },
  { id: "pen", label: "Pen", icon: Pencil },
  { id: "highlighter", label: "Highlighter", icon: Highlighter },
  { id: "arrow", label: "Arrow", icon: MoveUpRight },
  { id: "line", label: "Line", icon: Minus },
  { id: "ellipse", label: "Circle", icon: Circle },
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "text", label: "Text", icon: Type },
  { id: "blur", label: "Blur", icon: Grid3x3 },
];
const RECENT_KEY = "promptly.photos.recentEmoji";

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const plain = (o: EditOps) => JSON.stringify({ ...NONE, ...o, markup: o.markup ?? [] });
const isItem = (s: MarkupShape | undefined) => !!s && (s.type === "emoji" || s.type === "sticker");

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 16) : [];
  } catch {
    return [];
  }
}

function canShareFiles(): boolean {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([""], "x.jpg", { type: "image/jpeg" })] });
  } catch {
    return false;
  }
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function PhotoEditor({
  photo, onClose, onSaved, onSavedAsNew, opsOnly,
}: {
  photo: PhotoItem;
  onClose: () => void;
  onSaved?: (item: PhotoItem | null) => void;
  /** A new photo was made from the edit (``item`` once it's ready). */
  onSavedAsNew?: (item: PhotoItem | null) => void;
  /** Ops only (Porch, WP-P1.4): crop, filters and adjustments for one post.
   *  Nothing is saved to the library; Done hands the ops back (null: none).
   *  No markup, which stays a Photos feature. */
  opsOnly?: { initial: EditOps | null; onDone: (ops: EditOps | null) => void };
}) {
  const own = photo.mine !== false;
  const start0: EditOps = opsOnly?.initial ? { ...NONE, ...opsOnly.initial, markup: [] } : NONE;
  const [ops, setOps] = useState<EditOps>(start0);
  const [baseline, setBaseline] = useState(plain(start0));
  const [had, setHad] = useState(false);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tab, setTab] = useState<Tab>("crop");
  const [aspect, setAspect] = useState<number | "original" | null>(opsOnly ? (opsOnly.initial?.crop ? null : "original") : null);
  const aspects = opsOnly ? POST_ASPECTS : ASPECTS;
  const [busy, setBusy] = useState<null | "save" | "new" | "copy" | "share">(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  // Markup.
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [step, setStep] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [past, setPast] = useState<MarkupShape[][]>([]);
  const [future, setFuture] = useState<MarkupShape[][]>([]);
  const [draft, setDraft] = useState<MarkupShape | null>(null);
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; value: string } | null>(null);
  const [picker, setPicker] = useState<null | "emoji" | "sticker">(null);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [, setTick] = useState(0);
  useEffect(() => onStickerLoad(() => setTick((t) => t + 1)), []);
  const markup = useMemo(() => ops.markup ?? [], [ops.markup]);
  const opsRef = useRef(ops);
  opsRef.current = ops;

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const opsOnlyRef = useRef(opsOnly);
  opsOnlyRef.current = opsOnly;

  // The original's preview and the edit so far (yours only; someone
  // else's photo is marked up from the original, to copy or share).
  useEffect(() => {
    let off = false;
    const forPost = !!opsOnlyRef.current;
    void Promise.all([filesApi.signedUrls(photo.id), own && !forPost ? photosApi.getEdit(photo.id) : Promise.resolve({ ops: null })])
      .then(([urls, edit]) => {
        if (off) return;
        if (edit.ops) {
          const start = { ...NONE, ...edit.ops, markup: edit.ops.markup ?? [] };
          setOps(start);
          setBaseline(plain(start));
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
  }, [photo.id, own]);

  // The picture, turned and flipped — all of it while cropping, else the
  // cropped part (what's marked up) — as large as fits.
  const turned = ops.rotate === 90 || ops.rotate === 270;
  const full = img ? { w: turned ? img.naturalHeight : img.naturalWidth, h: turned ? img.naturalWidth : img.naturalHeight } : null;
  const frame: Crop = tab === "crop" ? WHOLE : ops.crop ?? WHOLE;
  const nat = full ? { w: full.w * frame.w, h: full.h * frame.h } : null;
  const fullNat = full;
  useEffect(() => {
    const el = stage.current;
    if (!el || !nat) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const s = Math.min((r.width - 24) / nat.w, (r.height - 24) / nat.h, 1.5);
      setBox({ w: Math.max(1, Math.round(nat.w * s)), h: Math.max(1, Math.round(nat.h * s)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nat?.w, nat?.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // The original turned and flipped, once per turn.
  const turnedPic = useMemo(() => {
    if (!img) return null;
    const c = document.createElement("canvas");
    c.width = turned ? img.naturalHeight : img.naturalWidth;
    c.height = turned ? img.naturalWidth : img.naturalHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.translate(c.width / 2, c.height / 2);
    if (ops.flip) ctx.scale(-1, 1);
    ctx.rotate((ops.rotate * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    return c;
  }, [img, ops.rotate, ops.flip, turned]);

  const filter = cssFilter(ops);
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  // Paint: the picture, then the marks (not while cropping — they belong
  // to the finished frame).
  useEffect(() => {
    const c = canvas.current;
    if (!c || !turnedPic || !box.w) return;
    c.width = Math.round(box.w * dpr);
    c.height = Math.round(box.h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    const tw = turnedPic.width, th = turnedPic.height;
    ctx.drawImage(turnedPic, frame.x * tw, frame.y * th, frame.w * tw, frame.h * th, 0, 0, c.width, c.height);
    const o = overlay.current;
    if (!o) return;
    o.width = c.width;
    o.height = c.height;
    const octx = o.getContext("2d");
    if (!octx) return;
    octx.clearRect(0, 0, o.width, o.height);
    if (tab === "crop") return;
    const shapes = draft ? [...markup, draft] : markup;
    drawMarkup(octx, shapes, o.width, o.height, c, filter);
    const sel = selected !== null ? markup[selected] : undefined;
    if (sel && tab === "markup") {
      octx.save();
      octx.strokeStyle = "#ffffff";
      octx.lineWidth = 1.5 * dpr;
      octx.setLineDash([6 * dpr, 4 * dpr]);
      octx.shadowColor = "rgba(0,0,0,0.8)";
      octx.shadowBlur = 3 * dpr;
      if (isItem(sel)) {
        const b = itemBox(octx, sel, o.width, o.height);
        octx.translate(b.cx, b.cy);
        octx.rotate(b.rot);
        octx.strokeRect(-b.hw, -b.hh, b.hw * 2, b.hh * 2);
        octx.setLineDash([]);
        octx.fillStyle = "#ffffff";
        octx.beginPath();
        octx.arc(b.hw, b.hh, 9 * dpr, 0, Math.PI * 2);
        octx.fill();
        octx.strokeStyle = "#0a84ff";
        octx.stroke();
      } else {
        const b = shapeBounds(octx, sel, o.width, o.height);
        const pad = 4 * dpr;
        octx.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2);
      }
      octx.restore();
    }
  }, [turnedPic, box, dpr, frame.x, frame.y, frame.w, frame.h, tab, markup, draft, selected, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const crop: Crop = ops.crop ?? WHOLE;
  const ratioOf = useCallback(
    (a: number | "original" | null): number | null => (a === "original" ? (fullNat ? fullNat.w / fullNat.h : null) : a),
    [fullNat],
  );

  // A crop of this aspect, as big as fits, centred.
  const fitAspect = (a: number | "original" | null) => {
    setAspect(a);
    // For a post, "Original" is the whole photo, uncropped.
    if (opsOnly && a === "original") {
      setOps((o) => ({ ...o, crop: null }));
      return;
    }
    const r = ratioOf(a);
    if (!r || !fullNat) return;
    let w = 1;
    let h = (fullNat.w / fullNat.h) / r;
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
      if (r && fullNat) {
        // Keep the shape: the height follows the width.
        const h = ((x1 - x0) * fullNat.w) / fullNat.h / r;
        if (d.handle.includes("n")) y0 = clamp(y1 - h, 0, y1 - min);
        else y1 = clamp(y0 + h, y0 + min, 1);
        const w = ((y1 - y0) * fullNat.h * r) / fullNat.w;
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
    const stepBy = e.shiftKey ? 0.05 : 0.01;
    const c = crop;
    let next: Crop | null = null;
    if (e.key === "ArrowLeft") next = { ...c, x: clamp(c.x - stepBy, 0, 1 - c.w) };
    else if (e.key === "ArrowRight") next = { ...c, x: clamp(c.x + stepBy, 0, 1 - c.w) };
    else if (e.key === "ArrowUp") next = { ...c, y: clamp(c.y - stepBy, 0, 1 - c.h) };
    else if (e.key === "ArrowDown") next = { ...c, y: clamp(c.y + stepBy, 0, 1 - c.h) };
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
  const dirty = plain(ops) !== baseline;
  const anything = plain(ops) !== plain(NONE);

  // ----------------------------------------------------------------- markup

  const setMarkup = (next: MarkupShape[], before?: MarkupShape[]) => {
    const prev = before ?? opsRef.current.markup ?? [];
    setPast((p) => [...p.slice(-99), prev]);
    setFuture([]);
    setOps((o) => ({ ...o, markup: next }));
  };
  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [markup, ...f]);
    setOps((o) => ({ ...o, markup: past[past.length - 1] }));
    setPast((p) => p.slice(0, -1));
    setSelected(null);
  };
  const redo = () => {
    if (!future.length) return;
    setPast((p) => [...p, markup]);
    setOps((o) => ({ ...o, markup: future[0] }));
    setFuture((f) => f.slice(1));
    setSelected(null);
  };
  const removeSelected = () => {
    if (selected === null) return;
    setMarkup(markup.filter((_, i) => i !== selected));
    setSelected(null);
  };
  const clearAll = () => {
    if (!markup.length) return;
    setMarkup([]);
    setSelected(null);
  };
  const pickColor = (c: string) => {
    setColor(c);
    const sel = selected !== null ? markup[selected] : undefined;
    if (sel && (sel.color || (sel.type === "sticker" && STICKERS.find((s) => s.id === sel.sticker)?.tint))) {
      setMarkup(markup.map((s, i) => (i === selected ? { ...s, color: c } : s)));
    }
  };
  const place = (shape: MarkupShape) => {
    setMarkup([...markup, shape]);
    setSelected(markup.length);
    setTool("select");
    setPicker(null);
  };
  const placeEmoji = (em: string) => {
    place({ type: "emoji", emoji: em, points: [[0.5, 0.5]], size: 0.22, rotation: 0 });
    const next = [em, ...recent.filter((r) => r !== em)].slice(0, 16);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* private mode: no recents */
    }
  };
  const placeSticker = (id: string) => {
    const tint = STICKERS.find((s) => s.id === id)?.tint;
    place({ type: "sticker", sticker: id, points: [[0.5, 0.5]], size: 0.3, rotation: 0, ...(tint ? { color } : {}) });
  };

  type Gesture =
    | { kind: "move"; idx: number; start: MarkupShape[]; x: number; y: number; moved: boolean }
    | { kind: "scale"; idx: number; start: MarkupShape[]; cx: number; cy: number; d0: number; a0: number; size: number; rot: number }
    | { kind: "draw" };
  const gesture = useRef<Gesture | null>(null);
  const norm = (e: React.PointerEvent): [number, number] => {
    const r = overlay.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  const onMarkDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (tab !== "markup" || !overlay.current) return;
    e.preventDefault();
    if (textDraft) {
      commitText();
      return;
    }
    const o = overlay.current;
    const ctx = o.getContext("2d")!;
    const [x, y] = norm(e);
    const W = o.width, H = o.height;
    const px = x * W, py = y * H;
    o.setPointerCapture(e.pointerId);
    if (tool === "select") {
      const sel = selected !== null ? markup[selected] : undefined;
      if (sel && isItem(sel)) {
        const b = itemBox(ctx, sel, W, H);
        const hx = b.cx + b.hw * Math.cos(b.rot) - b.hh * Math.sin(b.rot);
        const hy = b.cy + b.hw * Math.sin(b.rot) + b.hh * Math.cos(b.rot);
        if (Math.hypot(px - hx, py - hy) <= 22 * dpr) {
          gesture.current = {
            kind: "scale", idx: selected!, start: markup, cx: b.cx, cy: b.cy, d0: Math.hypot(hx - b.cx, hy - b.cy),
            a0: Math.atan2(hy - b.cy, hx - b.cx), size: sel.size ?? 0.2, rot: sel.rotation ?? 0,
          };
          return;
        }
      }
      const idx = hitTest(ctx, markup, px, py, W, H, 12 * dpr);
      setSelected(idx >= 0 ? idx : null);
      if (idx >= 0) gesture.current = { kind: "move", idx, start: markup, x, y, moved: false };
      return;
    }
    setSelected(null);
    if (tool === "text") {
      setTextDraft({ x, y, value: "" });
      return;
    }
    const width = tool === "highlighter" ? WIDTHS[step] * HIGHLIGHT_FACTOR : WIDTHS[step];
    gesture.current = { kind: "draw" };
    setDraft(
      tool === "pen" || tool === "highlighter"
        ? { type: tool, color, width, points: [[x, y]] }
        : tool === "blur"
          ? { type: "blur", points: [[x, y], [x, y]] }
          : { type: tool, color, width, points: [[x, y], [x, y]] },
    );
  };

  const onMarkMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g || !overlay.current) return;
    const [x, y] = norm(e);
    if (g.kind === "draw") {
      setDraft((d) => {
        if (!d) return d;
        if (d.type === "pen" || d.type === "highlighter") {
          const last = d.points[d.points.length - 1];
          const aspectR = box.w / Math.max(1, box.h);
          if (Math.hypot((x - last[0]) * aspectR, y - last[1]) < 0.003 || d.points.length >= 2000) return d;
          return { ...d, points: [...d.points, [x, y]] };
        }
        return { ...d, points: [d.points[0], [x, y]] };
      });
      return;
    }
    if (g.kind === "move") {
      const dx = x - g.x, dy = y - g.y;
      g.moved = g.moved || Math.abs(dx) + Math.abs(dy) > 0.002;
      setOps((o) => ({
        ...o,
        markup: g.start.map((s, i) => (i === g.idx ? { ...s, points: s.points.map(([px, py]) => [px + dx, py + dy] as [number, number]) } : s)),
      }));
      return;
    }
    const o = overlay.current;
    const px = x * o.width, py = y * o.height;
    const d = Math.hypot(px - g.cx, py - g.cy);
    const a = Math.atan2(py - g.cy, px - g.cx);
    let rot = g.rot + ((a - g.a0) * 180) / Math.PI;
    rot = ((((rot + 180) % 360) + 360) % 360) - 180;
    // Snap to upright near it.
    if (Math.abs(rot) < 4) rot = 0;
    const size = clamp((g.size * d) / Math.max(1, g.d0), 0.02, 1);
    setOps((o2) => ({ ...o2, markup: g.start.map((s, i) => (i === g.idx ? { ...s, size, rotation: Math.round(rot * 10) / 10 } : s)) }));
  };

  const onMarkUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === "draw") {
      const d = draft;
      setDraft(null);
      if (!d) return;
      if (d.type !== "pen" && d.type !== "highlighter") {
        const [[ax, ay], [bx, by]] = d.points;
        if (Math.hypot(ax - bx, ay - by) < 0.01) return;
      }
      setMarkup([...markup, d]);
      return;
    }
    if (g.kind === "move" && !g.moved) return;
    setMarkup(opsRef.current.markup ?? [], g.start);
  };

  const textRef = useRef(textDraft);
  textRef.current = textDraft;
  const commitText = () => {
    const t = textRef.current;
    textRef.current = null;
    setTextDraft(null);
    if (!t || !t.value.trim()) return;
    setMarkup([...markup, { type: "text", color, size: TEXT_SIZES[step], points: [[t.x, t.y]], text: t.value.trim().slice(0, 200) }]);
  };

  // ------------------------------------------------------------- ways out

  // With changes made, closing asks first (in the app's own sheet).
  const [closeAsk, setCloseAsk] = useState(false);
  const requestClose = useCallback(() => {
    if (plain(opsRef.current) !== baseline) return setCloseAsk(true);
    closeRef.current();
  }, [baseline]);
  const finish = () => {
    const o = { ...opsRef.current, markup: [] };
    opsOnlyRef.current?.onDone(plain(o) === plain(NONE) ? null : o);
  };

  const save = async () => {
    setBusy("save");
    try {
      const out = await photosApi.saveEdit(photo.id, ops);
      toast.success(out.ops ? "Saved — the original is kept." : "Back to the original.");
      onSaved?.(out.item);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save the edit."));
    } finally {
      setBusy(null);
    }
  };
  const revert = async () => {
    setBusy("save");
    try {
      const out = await photosApi.revertEdit(photo.id);
      toast.success("Back to the original.");
      onSaved?.(out.item);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't revert it."));
    } finally {
      setBusy(null);
    }
  };
  const saveAsNew = async () => {
    setBusy("new");
    try {
      const out = await photosApi.saveAsNew(photo.id, ops);
      toast.success(`Saved as a new photo, “${out.filename}”. The original is unchanged.`);
      // Its tile is made in the background: wait for it (a little).
      let item: PhotoItem | null = null;
      for (let i = 0; i < 30 && !item; i++) {
        const [got] = await photosApi.items([out.file_id]).catch(() => [] as PhotoItem[]);
        if (got?.thumb) item = got;
        else await new Promise((r) => window.setTimeout(r, 1000));
      }
      (onSavedAsNew ?? (() => closeRef.current()))(item);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save it as a new photo."));
    } finally {
      setBusy(null);
    }
  };
  const base = photo.filename.replace(/\.[^.]+$/, "");
  // Share on a phone, else download.
  const giveFile = async (blob: Promise<Blob>, ext: "png" | "jpg", why?: string) => {
    const data = await blob;
    const name = `${base} (edited).${ext}`;
    const file = new File([data], name, { type: ext === "png" ? "image/png" : "image/jpeg" });
    if (canShareFiles() && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)) {
      try {
        await navigator.share({ files: [file] });
        if (why) toast.info(why);
        return;
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
      }
    }
    saveBlob(data, name);
    toast.info(why ? `${why} It was downloaded instead.` : "Downloaded.");
  };
  const copy = () => {
    // The clipboard needs the write started in the click itself, so it
    // gets the picture as a promise (Safari's way; Chrome takes it too).
    const blob = photosApi.render(photo.id, ops, "png");
    blob.catch(() => undefined);
    setBusy("copy");
    const done = () => setBusy(null);
    const fallback = (why: string) =>
      giveFile(blob, "png", why).catch((e) => toast.error(apiErrorMessage(e, "Couldn't make the picture."))).finally(done);
    const canClip = typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write && window.isSecureContext;
    if (!canClip) {
      void fallback("This browser can't copy pictures.");
      return;
    }
    navigator.clipboard
      .write([new ClipboardItem({ "image/png": blob })])
      .then(() => {
        toast.success("Copied — paste it anywhere.");
        done();
      })
      .catch(async () => {
        try {
          await blob;
        } catch (e) {
          toast.error(apiErrorMessage(e, "Couldn't make the picture."));
          done();
          return;
        }
        void fallback("The browser didn't allow copying the picture.");
      });
  };
  const share = () => {
    setBusy("share");
    giveFile(photosApi.render(photo.id, ops, "jpeg"), "jpg")
      .catch((e) => toast.error(apiErrorMessage(e, "Couldn't make the picture.")))
      .finally(() => setBusy(null));
  };
  const sharing = useMemo(() => canShareFiles() && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent), []);

  // Keys: Esc closes (asks first with changes), Delete removes the picked
  // mark, Ctrl+Z / Ctrl+Shift+Z undo / redo.
  const keyState = useRef({ undo, redo, removeSelected, requestClose, picker, textDraft, tab, closeAsk });
  keyState.current = { undo, redo, removeSelected, requestClose, picker, textDraft, tab, closeAsk };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const s = keyState.current;
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]");
      // The "close without saving?" sheet is up: the keys are its own.
      if (s.closeAsk) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (s.picker) setPicker(null);
        else if (s.textDraft) setTextDraft(null);
        else s.requestClose();
        return;
      }
      if (typing || s.tab !== "markup") return;
      if ((e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        s.removeSelected();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        s.redo();
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
  const btn = "rounded-full p-2 text-white/90 hover:bg-white/10 disabled:opacity-40";
  const toolBtn = (active: boolean) =>
    cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", active ? "bg-white text-black" : "text-white/90 hover:bg-white/10");
  const sel = selected !== null ? markup[selected] : undefined;
  const short = Math.min(box.w, box.h);
  const q = query.trim().toLowerCase();
  const emojiGroups = q
    ? [{ group: "Results", items: EMOJI.flatMap((g) => g.items).filter(([, words]) => words.includes(q)) }]
    : [...(recent.length ? [{ group: "Recent", items: recent.map((r) => [r, ""] as [string, string]) }] : []), ...EMOJI];

  const action = "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-1.5 text-[11px] text-white/90 hover:bg-white/10 disabled:opacity-40 sm:flex-none sm:flex-row sm:gap-1.5 sm:px-3 sm:text-sm";

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={opsOnly ? "Edit for this post" : "Edit photo"} className="fixed inset-0 z-[70] flex flex-col bg-black text-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" aria-label="Close editor" onClick={requestClose} className={btn}>
          <X className="h-5 w-5" />
        </button>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{opsOnly ? "Edit for this post" : own ? "Edit" : "Mark up"}</span>
          {opsOnly && <span className="truncate text-xs text-white/70">The photo in your library stays as it is.</span>}
        </span>
        {opsOnly && anything && (
          <Button size="sm" variant="ghost" leftIcon={<Undo2 className="h-3.5 w-3.5" />} onClick={() => { setOps(NONE); setAspect("original"); }}
            className="text-white hover:bg-white/10">
            Reset
          </Button>
        )}
        {!opsOnly && own && had && (
          <Button size="sm" variant="ghost" leftIcon={<Undo2 className="h-3.5 w-3.5" />} disabled={!!busy} onClick={() => void revert()}
            className="text-white hover:bg-white/10">
            Revert to original
          </Button>
        )}
      </div>
      <div ref={stage} className="relative flex min-h-0 flex-1 items-center justify-center" onPointerMove={onMove} onPointerUp={onUp}>
        {!img ? (
          <Loader2 role="status" aria-label="Loading the photo" className="h-6 w-6 animate-spin text-white/60" />
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
            <canvas
              ref={overlay}
              data-testid="markup-canvas"
              aria-label={tab === "markup" ? "Markup — draw on the photo" : undefined}
              className={cn("absolute inset-0 z-20", tab === "markup" ? (tool === "select" ? "cursor-default" : "cursor-crosshair") : "pointer-events-none")}
              style={{ width: box.w, height: box.h, touchAction: "none" }}
              onPointerDown={onMarkDown}
              onPointerMove={onMarkMove}
              onPointerUp={onMarkUp}
              onPointerCancel={onMarkUp}
            />
            {textDraft && (
              <input
                autoFocus
                aria-label="Text to add"
                value={textDraft.value}
                maxLength={200}
                placeholder="Type…"
                onChange={(e) => setTextDraft((t) => t && { ...t, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitText();
                  }
                }}
                onBlur={commitText}
                className="absolute z-30 min-w-[6rem] rounded border border-dashed border-white/70 bg-black/30 px-0.5 font-bold outline-none"
                style={{
                  left: textDraft.x * box.w, top: textDraft.y * box.h, color,
                  fontSize: Math.max(12, TEXT_SIZES[step] * short), fontFamily: TEXT_FONT, lineHeight: 1.1,
                  maxWidth: box.w - textDraft.x * box.w,
                }}
              />
            )}
            {tab === "crop" && (
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
            )}
          </div>
        )}
      </div>

      <div className="border-t border-white/10 px-2 pt-2 sm:px-3">
        <div className="mb-2 flex justify-center gap-1" role="tablist">
          {(opsOnly ? (["crop", "filters", "adjust"] as const) : (["crop", "adjust", "markup"] as const)).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setSelected(null); setPicker(null); }}
              className={cn("rounded-full px-3 text-xs", opsOnly ? "py-1.5" : "py-1", tab === t ? "bg-white text-black" : "text-white/80 hover:bg-white/10")}>
              {t === "crop" ? (opsOnly ? "Crop" : "Crop & rotate") : t === "filters" ? "Filters" : t === "adjust" ? "Adjust" : "Mark up"}
            </button>
          ))}
        </div>
        {tab === "crop" && (
          <div className="flex flex-wrap items-center justify-center gap-1">
            <button type="button" aria-label="Rotate left" onClick={() => turn(-90)} className={btn}><RotateCcw className="h-5 w-5" /></button>
            <button type="button" aria-label="Rotate right" onClick={() => turn(90)} className={btn}><RotateCw className="h-5 w-5" /></button>
            <button type="button" aria-label="Flip" aria-pressed={ops.flip} onClick={() => setOps((o) => ({ ...o, flip: !o.flip, crop: o.crop && { ...o.crop, x: 1 - o.crop.x - o.crop.w } }))} className={btn}>
              <FlipHorizontal2 className="h-5 w-5" />
            </button>
            <span className="mx-2 h-5 w-px bg-white/20" />
            {aspects.map((a) => (
              <button key={a.label} type="button" aria-pressed={aspect === a.ratio} onClick={() => (a.ratio ? fitAspect(a.ratio) : setAspect(null))}
                className={cn("rounded-full px-2.5 py-1 text-xs", aspect === a.ratio ? "bg-white/20" : "text-white/80 hover:bg-white/10")}>
                {a.label}
              </button>
            ))}
            {ops.crop && !opsOnly && (
              <button type="button" onClick={() => setOps((o) => ({ ...o, crop: null }))} className="rounded-full px-2.5 py-1 text-xs text-white/80 hover:bg-white/10">
                No crop
              </button>
            )}
            {markup.length > 0 && <p className="w-full text-center text-[11px] text-white/50">Marks sit on the cropped picture — they move with the crop.</p>}
          </div>
        )}
        {tab === "filters" && (
          <div role="radiogroup" aria-label="Filters" className="flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] sm:justify-center">
            {FILTER_PRESETS.map((p) => {
              const on = presetOf(ops)?.id === p.id;
              return (
                <button key={p.id} type="button" role="radio" aria-checked={on} aria-label={p.label}
                  onClick={() => setOps((o) => ({ ...o, brightness: p.brightness, contrast: p.contrast, saturation: p.saturation }))}
                  className="flex shrink-0 flex-col items-center gap-1 rounded-lg p-1 text-[11px] text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                  <span className={cn("block h-16 w-16 overflow-hidden rounded-lg border-2", on ? "border-white" : "border-transparent")}>
                    {img && <img src={img.src} alt="" className="h-full w-full object-cover" style={{ filter: cssFilter(p) }} />}
                  </span>
                  <span className={cn(on && "font-semibold text-white")}>{p.label}</span>
                </button>
              );
            })}
          </div>
        )}
        {tab === "adjust" && (
          <div className="mx-auto grid max-w-xl gap-2 sm:grid-cols-3">
            {slider("brightness", "Brightness")}
            {slider("contrast", "Contrast")}
            {slider("saturation", "Saturation")}
          </div>
        )}
        {tab === "markup" && (
          <div className="mx-auto max-w-3xl space-y-1.5">
            <div className="flex items-center gap-0.5 overflow-x-auto pb-0.5 [scrollbar-width:none] sm:justify-center" role="toolbar" aria-label="Markup tools">
              {TOOLS.map((t) => (
                <button key={t.id} type="button" aria-label={t.label} title={t.label} aria-pressed={tool === t.id && !picker}
                  onClick={() => { setTool(t.id); setPicker(null); if (t.id !== "select") setSelected(null); }}
                  className={toolBtn(tool === t.id && !picker)}>
                  <t.icon className="h-5 w-5" />
                </button>
              ))}
              <button type="button" aria-label="Emoji" title="Emoji" aria-pressed={picker === "emoji"} onClick={() => setPicker((p) => (p === "emoji" ? null : "emoji"))} className={toolBtn(picker === "emoji")}>
                <Smile className="h-5 w-5" />
              </button>
              <button type="button" aria-label="Stickers" title="Stickers" aria-pressed={picker === "sticker"} onClick={() => setPicker((p) => (p === "sticker" ? null : "sticker"))} className={toolBtn(picker === "sticker")}>
                <Sticker className="h-5 w-5" />
              </button>
            </div>
            {picker === "emoji" && (
              <div className="rounded-xl bg-white/5 p-2">
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search emoji" aria-label="Search emoji"
                  className="mb-1.5 w-full rounded-lg bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/50 outline-none" />
                <div className="max-h-40 overflow-y-auto">
                  {emojiGroups.map((g) => (
                    <div key={g.group}>
                      <p className="px-1 pt-1 text-[11px] text-white/50">{g.group}</p>
                      <div className="grid grid-cols-8 gap-0.5 sm:grid-cols-12">
                        {g.items.map(([em, words]) => (
                          <button key={g.group + em} type="button" aria-label={words ? `Emoji ${words.split(" ")[0]}` : "Emoji"} title={words}
                            onClick={() => placeEmoji(em)} className="rounded-lg p-1 text-2xl leading-none hover:bg-white/10">
                            {em}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {q && !emojiGroups[0].items.length && <p className="p-2 text-xs text-white/60">No emoji match “{query}”.</p>}
                </div>
              </div>
            )}
            {picker === "sticker" && (
              <div className="grid max-h-40 grid-cols-6 gap-1 overflow-y-auto rounded-xl bg-white/5 p-2 sm:grid-cols-8">
                {STICKERS.map((s) => (
                  <button key={s.id} type="button" aria-label={`Sticker ${s.label}`} title={s.label} onClick={() => placeSticker(s.id)}
                    className="flex aspect-square items-center justify-center rounded-lg bg-white/5 p-1 hover:bg-white/15">
                    {s.tint ? (
                      <span aria-hidden="true" className="block h-full w-full" style={{
                        backgroundColor: color, WebkitMaskImage: `url(${stickerUrl(s.id)})`, maskImage: `url(${stickerUrl(s.id)})`,
                        WebkitMaskSize: "contain", maskSize: "contain", WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
                        WebkitMaskPosition: "center", maskPosition: "center",
                      }} />
                    ) : (
                      <img src={stickerUrl(s.id)} alt="" className="h-full w-full object-contain" />
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
              <div className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
                {COLORS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Colour ${c}`} onClick={() => pickColor(c)}
                    className={cn("h-7 w-7 rounded-full border-2", color === c ? "border-white ring-2 ring-white/40" : "border-white/30")}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
              <div className="flex items-center gap-0.5" role="radiogroup" aria-label="Thickness">
                {WIDTHS.map((_, i) => (
                  <button key={i} type="button" role="radio" aria-checked={step === i} aria-label={["Thin", "Medium", "Thick"][i]} onClick={() => setStep(i)}
                    className={cn("flex h-8 w-8 items-center justify-center rounded-full", step === i ? "bg-white/20" : "hover:bg-white/10")}>
                    <span className="block rounded-full bg-white" style={{ width: 4 + i * 5, height: 4 + i * 5 }} />
                  </button>
                ))}
              </div>
              <div className="flex items-center">
                <button type="button" aria-label="Undo" title="Undo" disabled={!past.length} onClick={undo} className={btn}><Undo2 className="h-5 w-5" /></button>
                <button type="button" aria-label="Redo" title="Redo" disabled={!future.length} onClick={redo} className={btn}><Redo2 className="h-5 w-5" /></button>
                {sel ? (
                  <button type="button" aria-label="Delete selected mark" title="Delete" onClick={removeSelected} className={cn(btn, "text-red-300")}>
                    <Trash2 className="h-5 w-5" />
                  </button>
                ) : (
                  <button type="button" disabled={!markup.length} onClick={clearAll} className="rounded-full px-2.5 py-1 text-xs text-white/80 hover:bg-white/10 disabled:opacity-40">
                    Clear all
                  </button>
                )}
              </div>
            </div>
            {isItem(sel) && <p className="text-center text-[11px] text-white/50">Drag to move · drag the round handle to resize and turn</p>}
          </div>
        )}
        {opsOnly ? (
          <div className="mt-2 flex items-center justify-end gap-2 border-t border-white/10 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2">
            <Button size="sm" variant="ghost" onClick={requestClose} className="text-white hover:bg-white/10">
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!img} onClick={finish} className="min-w-[5rem]">
              Done
            </Button>
          </div>
        ) : (
        <div className="mt-2 flex items-stretch gap-1 border-t border-white/10 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-1.5 sm:justify-end" aria-label="Save or share">
          <button type="button" onClick={copy} disabled={!!busy || !img} className={action} aria-label="Copy to clipboard">
            <Copy className="h-5 w-5" /> {busy === "copy" ? "Copying…" : "Copy"}
          </button>
          <button type="button" onClick={share} disabled={!!busy || !img} className={action} aria-label={sharing ? "Share" : "Download"}>
            {sharing ? <Share2 className="h-5 w-5" /> : <Download className="h-5 w-5" />} {busy === "share" ? "Making…" : sharing ? "Share" : "Download"}
          </button>
          {own && (
            <>
              <button type="button" onClick={() => void saveAsNew()} disabled={!!busy || !img || !anything} className={action} aria-label="Save as new photo">
                <ImagePlus className="h-5 w-5" /> {busy === "new" ? "Saving…" : <><span className="sm:hidden">Save new</span><span className="hidden sm:inline">Save as new photo</span></>}
              </button>
              <Button size="sm" variant="primary" loading={busy === "save"} disabled={!!busy || !dirty} onClick={() => void save()} className="min-w-[4.5rem] self-center">
                Save
              </Button>
            </>
          )}
        </div>
        )}
      </div>
      <Sheet
        open={closeAsk}
        onClose={() => setCloseAsk(false)}
        title={opsOnly ? "Close without keeping these changes?" : "Close without saving?"}
        size="sm"
        footer={
          <>
            <ItemButton variant="secondary" data-autofocus onClick={() => setCloseAsk(false)}>
              Keep editing
            </ItemButton>
            <ItemButton
              variant="danger"
              onClick={() => {
                setCloseAsk(false);
                closeRef.current();
              }}
            >
              {opsOnly ? "Close" : "Close without saving"}
            </ItemButton>
          </>
        }
      >
        <p className="text-sm text-[var(--text)]">
          {opsOnly ? "The changes you made here won't be kept." : "Your changes will be lost. The photo stays as it was."}
        </p>
      </Sheet>
    </div>,
    document.body,
  );
}
