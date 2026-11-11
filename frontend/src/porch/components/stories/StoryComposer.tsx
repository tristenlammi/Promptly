import { RowsSkeleton } from "../ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Camera, ChevronRight, FileText, Images, Loader2, MapPin, Minus, Pencil, Plus, Trash2, Type, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import type { PhotoItem } from "@/api/photos";
import { porchApi, type PorchUser, type PostPlace, type StoryBackground, type StoryOverlayIn, type StoryTextStyle } from "@/api/porch";
import { confirm } from "@/components/shared/ConfirmDialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Field, ItemButton, Segmented, Sheet, TextArea, TextInput } from "@/items/ui";
import { useUploadStore } from "@/store/uploadStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { BOOTSTRAP_KEY, STORIES_KEY } from "../../cache";
import { usePorch } from "../../context";
import { AudienceSheet, audienceIds, audienceWords } from "../composer/AudienceSheet";
import type { Audience } from "../composer/model";
import { videoSeconds } from "../composer/model";
import { PickStep } from "../composer/PickStep";
import { PlaceSheet, type PlaceOption } from "../composer/PlaceSheet";
import { PorchAvatar } from "../ui";
import { TEXT_STYLE_LABEL } from "./look";
import { OverlayEditor, overlayWords, type EditOverlay } from "./OverlayLayer";
import { BackgroundPicker, TextStoryEditor } from "./TextStoryEditor";

interface Picked {
  kind: "image" | "video";
  /** The library file, once it's there (an upload: when it finishes). */
  fileId: string | null;
  taskId?: string;
  /** What to show while editing: the library tile, or the photo on this device. */
  url: string | null;
  /** ``url`` is a still of a video (a library video's tile). */
  still?: boolean;
  error?: string;
  progress?: number;
}

type Sheet_ = null | "library" | "audience" | "place" | "mention" | "text" | "alt";

let seq = 0;
const newKey = () => `o${Date.now().toString(36)}${(seq++).toString(36)}`;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where the picture sits in the 9:16 frame: zoom (1 = just fills it) and
 *  the middle of what's shown, as shares of the picture. */
interface View {
  zoom: number;
  cx: number;
  cy: number;
}

/** What part of the picture a view shows (shares of the picture). */
function cropOf(v: View, iw: number, ih: number) {
  const frame = 9 / 16;
  const img = iw / ih;
  // At zoom 1 the picture just covers the frame.
  const fw = (img > frame ? frame / img : 1) / v.zoom;
  const fh = (img > frame ? 1 : img / frame) / v.zoom;
  return { fw, fh, x: clamp(v.cx - fw / 2, 0, 1 - fw), y: clamp(v.cy - fh / 2, 0, 1 - fh) };
}

/** The photo in the 9:16 frame: drag to move it, pinch, scroll or the
 *  slider to zoom. Arrow keys move it too. */
function PhotoCropper({
  url,
  view,
  onView,
  onSize,
  size,
}: {
  url: string;
  view: View;
  onView: (v: View) => void;
  size: { w: number; h: number } | null;
  onSize: (s: { w: number; h: number }) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ v: View; pts: { x: number; y: number }[] } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const fit = useCallback(
    (v: View): View => {
      if (!size) return v;
      const zoom = clamp(v.zoom, 1, 4);
      const c = cropOf({ ...v, zoom }, size.w, size.h);
      return { zoom, cx: clamp(v.cx, c.fw / 2, 1 - c.fw / 2), cy: clamp(v.cy, c.fh / 2, 1 - c.fh / 2) };
    },
    [size],
  );

  const down = (e: ReactPointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start.current = { v: viewRef.current, pts: [...pts.current.values()] };
  };
  const move = (e: ReactPointerEvent) => {
    if (!pts.current.has(e.pointerId) || !start.current || !box.current || !size) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = [...pts.current.values()];
    const s = start.current;
    const rect = box.current.getBoundingClientRect();
    const c = cropOf(s.v, size.w, size.h);
    if (now.length === 1 && s.pts.length === 1) {
      // A frame's width of drag moves the picture by what's shown of it.
      onView(fit({ ...s.v, cx: s.v.cx - ((now[0].x - s.pts[0].x) / rect.width) * c.fw, cy: s.v.cy - ((now[0].y - s.pts[0].y) / rect.height) * c.fh }));
    } else if (now.length >= 2 && s.pts.length >= 2) {
      const d0 = Math.hypot(s.pts[1].x - s.pts[0].x, s.pts[1].y - s.pts[0].y) || 1;
      const d1 = Math.hypot(now[1].x - now[0].x, now[1].y - now[0].y);
      onView(fit({ ...s.v, zoom: s.v.zoom * (d1 / d0) }));
    }
  };
  const up = (e: ReactPointerEvent) => {
    pts.current.delete(e.pointerId);
    const left = [...pts.current.values()];
    start.current = left.length ? { v: viewRef.current, pts: left } : null;
  };
  const wheel = (e: ReactWheelEvent) => onView(fit({ ...viewRef.current, zoom: viewRef.current.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08) }));

  // Draw it: the picture sized and moved so the view's part fills the frame.
  let style: React.CSSProperties = { opacity: 0 };
  if (size) {
    const c = cropOf(view, size.w, size.h);
    style = { width: `${100 / c.fw}%`, height: `${100 / c.fh}%`, left: `${(-c.x / c.fw) * 100}%`, top: `${(-c.y / c.fh) * 100}%` };
  }
  return (
    <div
      ref={box}
      className="absolute inset-0 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onWheel={wheel}
      tabIndex={0}
      role="application"
      aria-label="Your photo. Drag to move it in the frame, pinch or scroll to zoom. Arrow keys move it."
      onKeyDown={(e) => {
        const step = 0.02;
        const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (!d[e.key]) return;
        e.preventDefault();
        onView(fit({ ...view, cx: view.cx + d[e.key][0], cy: view.cy + d[e.key][1] }));
      }}
    >
      <img
        src={url}
        alt=""
        draggable={false}
        onLoad={(e) => onSize({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
        className="pointer-events-none absolute max-w-none select-none"
        style={style}
      />
    </div>
  );
}

/** Add an @mention: only people who'll see the story. */
function MentionSheet({ open, onClose, people, loading, onPick }: { open: boolean; onClose: () => void; people: PorchUser[]; loading: boolean; onPick: (u: PorchUser) => void }) {
  const [q, setQ] = useState("");
  useEffect(() => {
    if (open) setQ("");
  }, [open]);
  const shown = people.filter((u) => !q.trim() || `${u.name} ${u.username}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Sheet open={open} onClose={onClose} title="Mention someone" size="sm">
      <p className="mb-2 text-xs text-[var(--text-muted)]">Only people in the groups you're sharing to. They'll get a notification.</p>
      <TextInput data-autofocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names" aria-label="Search names" />
      <ul className="-mx-2 mt-2 flex flex-col">
        {loading && <li className="px-2"><RowsSkeleton rows={3} /></li>}
        {!loading && shown.length === 0 && <li className="px-2 py-3 text-sm text-[var(--text-muted)]">{people.length ? "Nobody by that name here." : "Nobody else is in these groups yet."}</li>}
        {shown.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              onClick={() => {
                onPick(u);
                onClose();
              }}
              className="flex min-h-[52px] w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
            >
              <PorchAvatar user={u} size={36} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-[var(--text)]">{u.name}</span>
                <span className="block truncate text-xs text-[var(--text-muted)]">@{u.username}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/** Write (or change) a text sticker and pick its style. */
function TextStickerSheet({
  open,
  onClose,
  initial,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  initial: { text: string; style: StoryTextStyle } | null;
  onSave: (text: string, style: StoryTextStyle) => void;
}) {
  const [text, setText] = useState("");
  const [style, setStyle] = useState<StoryTextStyle>("classic");
  useEffect(() => {
    if (!open) return;
    setText(initial?.text ?? "");
    setStyle(initial?.style ?? "classic");
  }, [open, initial]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={initial ? "Change the words" : "Add words"}
      size="sm"
      footer={
        <div className="flex w-full justify-end gap-2">
          <ItemButton variant="ghost" onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton
            variant="primary"
            disabled={!text.trim()}
            onClick={() => {
              onSave(text.trim(), style);
              onClose();
            }}
          >
            {initial ? "Done" : "Add"}
          </ItemButton>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <TextArea data-autofocus value={text} maxLength={200} rows={3} onChange={(e) => setText(e.target.value)} placeholder="What do you want to say?" aria-label="Words" />
        <Segmented<StoryTextStyle>
          value={style}
          onChange={setStyle}
          options={(["classic", "bold", "box"] as const).map((v) => ({ value: v, label: TEXT_STYLE_LABEL[v] }))}
        />
      </div>
    </Sheet>
  );
}

/**
 * ``/porch/story/new``: Camera, Library or Text, then the story in its
 * 9:16 frame — move and zoom a photo to crop it for this story, or type on
 * a colour — with text, @mention and place stickers, and the same "who
 * sees it" choice as a post. New photos and videos land in your Photos
 * library. Videos up to a minute; a longer one offers to become a post.
 */
export function StoryComposer() {
  const { b } = usePorch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isPhone = useIsMobile(767);
  const startUploads = useUploadStore((s) => s.startUploads);
  const tasks = useUploadStore((s) => s.tasks);
  const maxVideoMs = (b.limits.story_video_max_seconds ?? 60) * 1000;

  const [mode, setMode] = useState<"start" | "media" | "text">("start");
  const [media, setMedia] = useState<Picked | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, cx: 0.5, cy: 0.5 });
  const [text, setText] = useState("");
  const [bg, setBg] = useState<StoryBackground>("sunset");
  const [overlays, setOverlays] = useState<EditOverlay[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [alt, setAlt] = useState("");
  const [altTouched, setAltTouched] = useState(false);
  const [sheet, setSheet] = useState<Sheet_>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urls = useRef<string[]>([]);
  const camera = useRef<HTMLInputElement>(null);

  const [audience, setAudience] = useState<Audience>(() => {
    const last = b.profile.last_story_groups;
    const known = Array.isArray(last) ? last.filter((id) => b.groups.some((g) => g.id === id)) : [];
    return Array.isArray(last) && known.length ? known : "all";
  });
  const audIds = useMemo(() => audienceIds(audience, b.groups), [audience, b.groups]);
  const people = useQuery({
    queryKey: ["porch", "people", "audience", audIds.join(",")],
    queryFn: () => porchApi.people("", { groups: audIds }),
    enabled: audIds.length > 0,
    staleTime: 60_000,
  });

  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
    },
    [],
  );

  // What Photos knows about a library photo: its description and town.
  const info = useQuery({
    queryKey: ["porch", "compose", "files", media?.fileId ?? ""],
    queryFn: () => porchApi.composeFiles([media!.fileId!]),
    enabled: !!media?.fileId,
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    const cap = info.data?.[0]?.caption;
    if (cap && !altTouched && !alt) setAlt(cap);
  }, [info.data, altTouched, alt]);
  const photoPlaces: PlaceOption[] = info.data?.[0]?.place ? [info.data[0].place] : [];

  // Follow an upload until the library file is there.
  useEffect(() => {
    if (!media?.taskId || media.fileId || media.error) return;
    const t = tasks.find((x) => x.id === media.taskId);
    if (!t) return;
    if (t.status === "done" && t.result) setMedia({ ...media, fileId: t.result.id, progress: 1 });
    else if (t.status === "error" || t.status === "cancelled") setMedia({ ...media, error: t.status === "cancelled" ? "The upload was stopped." : t.error || "The upload failed." });
    else if (t.size && Math.abs(t.uploaded / t.size - (media.progress ?? 0)) > 0.02) setMedia({ ...media, progress: t.uploaded / t.size });
  }, [tasks, media]);

  const tooLong = async (post: () => void) => {
    const ok = await confirm({
      title: "Stories can be up to a minute",
      message: "Post it instead? It opens in a new post, where videos can be longer.",
      confirmLabel: "Post it instead",
    });
    if (ok) post();
  };

  const takeFile = async (f: File) => {
    const video = f.type.startsWith("video/");
    if (!video && !f.type.startsWith("image/")) {
      toast.error(`“${f.name}” isn't a photo or a video.`);
      return;
    }
    if (video) {
      const secs = await videoSeconds(f);
      if (secs !== null && secs * 1000 > maxVideoMs) {
        await tooLong(async () => {
          const { stashSharedFiles } = await import("@/lib/shareTargetStash");
          await stashSharedFiles([f], "porch");
          navigate("/porch/new?shared=1", { replace: true });
        });
        return;
      }
    }
    const [taskId] = startUploads({ files: [f], scope: "mine", folderId: null, route: "camera" });
    const url = URL.createObjectURL(f);
    urls.current.push(url);
    setMedia({ kind: video ? "video" : "image", fileId: null, taskId, url, progress: 0 });
    setSize(null);
    setView({ zoom: 1, cx: 0.5, cy: 0.5 });
    setMode("media");
  };

  const takeLibrary = (p: PhotoItem) => {
    setSheet(null);
    if (p.kind === "video" && p.duration_ms && p.duration_ms > maxVideoMs) {
      void tooLong(() => navigate(`/porch/new?file=${p.id}`, { replace: true }));
      return;
    }
    setMedia({ kind: p.kind, fileId: p.id, url: p.thumb, still: p.kind === "video" });
    setSize(null);
    setView({ zoom: 1, cx: 0.5, cy: 0.5 });
    setMode("media");
  };

  // ---------------------------------------------------------------- stickers
  const addOverlay = (o: StoryOverlayIn | EditOverlay) => {
    const key = newKey();
    setOverlays((os) => [...os, { ...(o as EditOverlay), key }]);
    setSelected(key);
  };
  const base = (y = 0.5) => ({ x: 0.5, y, scale: 1, rotate: 0, style: "classic" as StoryTextStyle });
  const sel = overlays.find((o) => o.key === selected) ?? null;
  const patchSel = (patch: Partial<EditOverlay>) => setOverlays((os) => os.map((o) => (o.key === selected ? ({ ...o, ...patch } as EditOverlay) : o)));
  const editingSticker = editing ? overlays.find((o) => o.key === editing) : null;

  // Mentions of people who won't see it are left off (the server does too).
  const audienceSet = useMemo(() => new Set((people.data ?? []).map((u) => u.id)), [people.data]);
  const outside = overlays.filter((o) => o.type === "mention" && people.isSuccess && !audienceSet.has(o.user.id));

  // ---------------------------------------------------------------- posting
  const has = mode === "text" ? !!text.trim() : !!media && !media.error;
  const uploading = !!media && !media.fileId && !media.error;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      let edit = null;
      if (mode === "media" && media?.kind === "image" && size) {
        const c = cropOf(view, size.w, size.h);
        if (c.fw < 0.995 || c.fh < 0.995) edit = { crop: { x: c.x, y: c.y, w: c.fw, h: c.fh } };
      }
      const keep = overlays.filter((o) => !(o.type === "mention" && people.isSuccess && !audienceSet.has(o.user.id)));
      const ovs: StoryOverlayIn[] = keep.map(({ key: _k, ...o }) => (o.type === "mention" ? { ...o, user: undefined, user_id: o.user.id } : o) as StoryOverlayIn);
      await porchApi.createStory({
        kind: mode === "text" ? "text" : media?.kind === "video" ? "video" : "photo",
        groups: audience,
        ...(mode === "text" ? { text: text.trim(), background: bg } : { file_id: media!.fileId!, edit, alt_text: alt.trim() }),
        overlays: ovs,
      });
      void qc.invalidateQueries({ queryKey: STORIES_KEY });
      void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      toast.success("Added to your story. It's there for a day.");
      navigate("/porch/", { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't share your story."));
    } finally {
      setBusy(false);
      setWaiting(false);
    }
  }, [mode, media, size, view, overlays, people.isSuccess, audienceSet, audience, text, bg, alt, qc, navigate]);

  const share = () => {
    if (media?.error) {
      setError(media.error);
      return;
    }
    if (uploading) {
      setWaiting(true);
      return;
    }
    void submit();
  };
  useEffect(() => {
    if (waiting && media?.fileId && !busy) void submit();
    if (waiting && media?.error) {
      setWaiting(false);
      setError(media.error);
    }
  }, [waiting, media, busy, submit]);

  const dirty = mode !== "start" && (has || overlays.length > 0);
  const close = async () => {
    if (dirty && !(await confirm({ title: "Throw this story away?", message: "Anything you took is still in your Photos library.", confirmLabel: "Throw away", danger: true }))) return;
    const st = window.history.state as { idx?: number } | null;
    if (st && typeof st.idx === "number" && st.idx > 0) navigate(-1);
    else navigate("/porch/", { replace: true });
  };
  const back = async () => {
    if (dirty && !(await confirm({ title: "Start again?", message: "This story will be thrown away.", confirmLabel: "Start again", danger: true }))) return;
    setMode("start");
    setMedia(null);
    setOverlays([]);
    setText("");
    setAlt("");
    setAltTouched(false);
    setSelected(null);
    setError(null);
  };

  // Esc closes (unless a sheet is open: it closes that).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => !el.hasAttribute("data-story-composer"))) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) {
        t.blur();
        return;
      }
      void close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const tool =
    "flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";

  const startTile =
    "flex min-h-[88px] flex-1 flex-col items-center justify-center gap-2 rounded-2xl bg-white/10 px-3 py-4 text-sm font-semibold text-white hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New story"
      data-story-composer
      className="fixed inset-0 z-[45] flex flex-col bg-black text-white pt-safe pb-safe md:items-center md:justify-center"
    >
      <input
        ref={camera}
        type="file"
        accept="image/*,video/*"
        capture="environment"
        hidden
        data-testid="story-camera"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void takeFile(f);
        }}
      />
      {mode === "start" ? (
        <div className="flex h-full w-full flex-col md:h-auto md:max-w-md">
          <header className="flex h-14 items-center gap-2 px-2">
            <button type="button" aria-label="Close" onClick={() => void close()} className={tool}>
              <X className="h-6 w-6" />
            </button>
            <h1 className="text-lg font-bold">New story</h1>
          </header>
          <div className="flex flex-1 flex-col justify-center gap-3 px-4 pb-8">
            <p className="text-center text-sm text-white/75">A photo, a short video or a few words, for a day. Only the groups you pick see it.</p>
            <div className="flex gap-3">
              <button type="button" className={startTile} onClick={() => camera.current?.click()}>
                {isPhone ? <Camera className="h-7 w-7" aria-hidden /> : <Upload className="h-7 w-7" aria-hidden />}
                {isPhone ? "Camera" : "Upload"}
              </button>
              <button type="button" className={startTile} onClick={() => setSheet("library")}>
                <Images className="h-7 w-7" aria-hidden />
                From Photos
              </button>
              <button
                type="button"
                className={startTile}
                onClick={() => {
                  setMode("text");
                  setMedia(null);
                }}
              >
                <Type className="h-7 w-7" aria-hidden />
                Text
              </button>
            </div>
            <p className="text-center text-xs text-white/60">New photos and videos are saved in your Photos library. Videos can be up to a minute.</p>
          </div>
        </div>
      ) : (
        <div className="flex h-full w-full flex-col md:h-[min(100dvh-32px,960px)] md:w-auto md:flex-row md:items-stretch md:gap-4">
          {/* The frame, with its tools on top. */}
          <div className="relative min-h-0 flex-1 md:aspect-[9/16] md:flex-none md:overflow-hidden md:rounded-2xl">
            <div
              className="absolute inset-0 overflow-hidden bg-neutral-900"
              style={{ containerType: "inline-size" }}
              onPointerDownCapture={(e) => {
                // A tap off the stickers lets go of the one that's selected.
                if (!(e.target as HTMLElement).closest("[data-sticker]")) setSelected(null);
              }}
            >
              {mode === "text" ? (
                <TextStoryEditor text={text} onText={setText} background={bg} />
              ) : media?.kind === "video" && media.url && !media.still ? (
                <video src={media.url} className="absolute inset-0 h-full w-full object-contain" autoPlay muted loop playsInline aria-label="Your video" />
              ) : media?.kind === "video" ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  {media.url && <img src={media.url} alt="Your video" className="absolute inset-0 h-full w-full object-contain" />}
                  <span className="relative rounded-full bg-black/55 px-3 py-1.5 text-sm">Video</span>
                </div>
              ) : media?.url ? (
                <PhotoCropper url={media.url} view={view} onView={setView} size={size} onSize={setSize} />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-white/70">
                  <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading your photo" />
                </div>
              )}
              <OverlayEditor overlays={overlays} onChange={setOverlays} selected={selected} onSelect={setSelected} />
            </div>
            <div className="absolute inset-x-0 top-0 flex items-start gap-2 bg-gradient-to-b from-black/50 to-transparent p-2">
              <button type="button" aria-label="Start again" onClick={() => void back()} className={tool}>
                <X className="h-6 w-6" />
              </button>
              {uploading && (
                <span className="mt-2.5 rounded-full bg-black/50 px-2.5 py-1 text-xs" aria-live="polite">
                  Saving to Photos… {Math.round((media?.progress ?? 0) * 100)}%
                </span>
              )}
              <div className="ml-auto flex flex-col gap-2">
                <button type="button" aria-label="Add words" title="Words" onClick={() => setSheet("text")} className={tool}>
                  <Type className="h-5 w-5" />
                </button>
                <button type="button" aria-label="Mention someone" title="Mention" onClick={() => setSheet("mention")} className={tool}>
                  <AtSign className="h-5 w-5" />
                </button>
                <button type="button" aria-label="Add a place" title="Place" onClick={() => setSheet("place")} className={tool}>
                  <MapPin className="h-5 w-5" />
                </button>
                {mode === "media" && media?.kind === "image" && (
                  <button type="button" aria-label="Describe the photo" title="Description" onClick={() => setSheet("alt")} className={tool}>
                    <FileText className="h-5 w-5" />
                  </button>
                )}
              </div>
            </div>
            {sel && (
              <div className="absolute inset-x-0 bottom-2 flex justify-center px-2" data-story-control>
                <div role="toolbar" aria-label={`Sticker: ${overlayWords(sel)}`} className="flex items-center gap-1 rounded-full bg-black/65 p-1 backdrop-blur">
                  {sel.type === "text" && (
                    <>
                      <button type="button" className={cn(tool, "bg-transparent")} aria-label="Change the words" onClick={() => setEditing(sel.key)}>
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="h-11 rounded-full px-3 text-sm font-semibold hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                        onClick={() => patchSel({ style: sel.style === "classic" ? "bold" : sel.style === "bold" ? "box" : "classic" })}
                        aria-label={`Style: ${TEXT_STYLE_LABEL[sel.style]}. Change it`}
                      >
                        {TEXT_STYLE_LABEL[sel.style]}
                      </button>
                    </>
                  )}
                  <button type="button" className={cn(tool, "bg-transparent")} aria-label="Smaller" onClick={() => patchSel({ scale: clamp(sel.scale / 1.2, 0.4, 3.5) })}>
                    <Minus className="h-4 w-4" />
                  </button>
                  <button type="button" className={cn(tool, "bg-transparent")} aria-label="Bigger" onClick={() => patchSel({ scale: clamp(sel.scale * 1.2, 0.4, 3.5) })}>
                    <Plus className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className={cn(tool, "bg-transparent")}
                    aria-label="Take it off"
                    onClick={() => {
                      setOverlays((os) => os.filter((o) => o.key !== sel.key));
                      setSelected(null);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Who sees it, and Share. */}
          <div className="flex shrink-0 flex-col gap-2 px-3 py-3 md:w-72 md:justify-end md:px-0">
            {mode === "text" && <BackgroundPicker value={bg} onChange={setBg} />}
            {outside.length > 0 && (
              <p className="text-xs text-white/75">
                {outside.map((o) => (o.type === "mention" ? o.user.name : "")).join(", ")} won't see this story, so {outside.length === 1 ? "that mention is" : "those mentions are"} left off.
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-xl bg-red-500/20 px-3 py-2 text-sm text-red-100">
                {error}
              </p>
            )}
            {waiting && !error && (
              <p className="flex items-center gap-2 text-sm text-white/80" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Sharing when your upload finishes…
              </p>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSheet("audience")}
                className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-full bg-white/10 px-4 text-left text-sm hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <span className="shrink-0 text-white/70">To</span>
                <span className="min-w-0 flex-1 truncate font-semibold">{audienceWords(audience, b.groups)}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-white/70" aria-hidden />
              </button>
              <button
                type="button"
                onClick={share}
                disabled={!has || busy || waiting}
                className="inline-flex h-12 shrink-0 items-center gap-2 rounded-full bg-[var(--item-accent-fill)] px-5 text-sm font-bold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                {(busy || waiting) && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Share
              </button>
            </div>
          </div>
        </div>
      )}

      <Sheet open={sheet === "library"} onClose={() => setSheet(null)} title="Pick a photo or video" size="full">
        <PickStep
          picks={[]}
          onToggle={takeLibrary}
          onFiles={(fs) => {
            setSheet(null);
            if (fs[0]) void takeFile(fs[0]);
          }}
          onTextPost={() => undefined}
          isPhone={isPhone}
          maxVideoMs={maxVideoMs}
          showTextLink={false}
        />
      </Sheet>
      <AudienceSheet open={sheet === "audience"} onClose={() => setSheet(null)} value={audience} onChange={setAudience} groups={b.groups} />
      <PlaceSheet
        open={sheet === "place"}
        onClose={() => setSheet(null)}
        fromPhotos={photoPlaces}
        onPick={(p: PostPlace) => addOverlay({ ...base(0.72), type: "place", place: p } as EditOverlay)}
      />
      <MentionSheet
        open={sheet === "mention"}
        onClose={() => setSheet(null)}
        people={people.data ?? []}
        loading={people.isPending && audIds.length > 0}
        onPick={(u) => addOverlay({ ...base(0.62), type: "mention", user: u } as EditOverlay)}
      />
      <TextStickerSheet
        open={sheet === "text" || !!editingSticker}
        onClose={() => {
          setSheet(null);
          setEditing(null);
        }}
        initial={editingSticker && editingSticker.type === "text" ? { text: editingSticker.text, style: editingSticker.style } : null}
        onSave={(t, style) => {
          if (editingSticker) setOverlays((os) => os.map((o) => (o.key === editingSticker.key ? ({ ...o, text: t, style } as EditOverlay) : o)));
          else addOverlay({ ...base(0.3), style, type: "text", text: t } as EditOverlay);
        }}
      />
      <Sheet
        open={sheet === "alt"}
        onClose={() => setSheet(null)}
        title="Describe the photo"
        size="sm"
        footer={
          <div className="flex w-full justify-end">
            <ItemButton variant="primary" onClick={() => setSheet(null)}>
              Done
            </ItemButton>
          </div>
        }
      >
        <Field label="Description" hint="Read out by screen readers. Photos' own description is filled in when it has one.">
          <TextArea
            data-autofocus
            value={alt}
            maxLength={1000}
            rows={3}
            onChange={(e) => {
              setAlt(e.target.value);
              setAltTouched(true);
            }}
          />
        </Field>
      </Sheet>
    </div>,
    document.body,
  );
}
