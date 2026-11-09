import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { linksApi } from "@/api/links";
import { memoriesApi } from "@/api/memories";
import { photosApi, type PhotoItem } from "@/api/photos";
import { porchApi, type PorchPost, type PorchUser } from "@/api/porch";
import { Callout } from "@/components/shared/Callout";
import { confirm } from "@/components/shared/ConfirmDialog";
import { ItemButton } from "@/items/ui";
import { useUploadStore } from "@/store/uploadStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { BOOTSTRAP_KEY, LISTS, putPost } from "../../cache";
import { usePorch } from "../../context";
import { scrollPorchTo } from "../../scroll";
import { ArrangeStep } from "./ArrangeStep";
import { AudienceSheet, audienceIds } from "./AudienceSheet";
import { LifeEventEditor } from "./LifeEventEditor";
import { mentionedIn } from "./MentionBox";
import {
  EMPTY, clearDraft, firstLink, hasContent, loadDraft, newKey, pollProblem, saveDraft, videoLimitWords, videoSeconds,
  type Audience, type Draft, type Pick, type Step,
} from "./model";
import { PickImage } from "./PickImage";
import { PickStep } from "./PickStep";
import { PlaceSheet } from "./PlaceSheet";
import { PollEditor } from "./PollEditor";
import { ShareStep } from "./ShareStep";

export interface ComposerStart {
  /** ``?group=``: posting from a group's page. */
  group?: string | null;
  /** ``?memory=``: "Share this memory" from Photos. */
  memory?: string | null;
  /** ``?shared=1``: from the phone's share sheet. */
  shared?: boolean;
  /** ``?for=<user id>``: "Post for Sam" on their birthday (Today, Porch). */
  forUser?: string | null;
  /** ``?file=<library file id>``: a video too long for a story, posted instead. */
  file?: string | null;
}

const STEP_TITLES: Record<Step, string> = { pick: "Pick photos", arrange: "Arrange", share: "Share" };

function fromPost(post: PorchPost): Draft {
  return {
    ...EMPTY,
    step: "share",
    picks: post.media.map((m) => ({
      key: m.id,
      mediaId: m.id,
      fileId: m.file_id ?? null,
      // The post's own tile already has its edit in it: start from the library's.
      thumb: m.edited ? null : m.thumb ?? m.poster,
      kind: m.kind,
      name: "",
      width: m.width,
      height: m.height,
      durationMs: m.duration_ms,
      thumbhash: m.thumbhash,
      edit: m.kind === "image" ? m.edit ?? null : null,
      alt: m.alt_text,
      altTouched: true,
      tags: (m.tags ?? []).map((t) => ({ user: t.user, x: t.x, y: t.y, status: t.status })),
    })),
    body: post.body,
    mentions: post.mentions,
    audience: post.groups.map((g) => g.id),
    place: post.place,
    life: post.life_event,
    poll: null,
    link: post.link,
  };
}

/**
 * The composer (``/porch/new``, and ``/porch/p/:id/edit`` for your own post):
 * Pick → Arrange → Share (build §3.3). Photos come from your own library
 * or a new upload/camera (saved into Photos with ``route=camera``); each
 * one's crop and filter is for this post only. Full screen on a phone, the
 * middle column on a computer. A new post is kept as a draft on this device
 * until it's posted or thrown away.
 */
export function Composer({ start, editing }: { start?: ComposerStart; editing?: PorchPost }) {
  const { b, isPhone } = usePorch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const startUploads = useUploadStore((s) => s.startUploads);
  const tasks = useUploadStore((s) => s.tasks);
  const maxMedia = b.limits.max_media;
  const maxVideoMs = b.limits.video_max_seconds * 1000;
  const limitWords = videoLimitWords(b.limits.video_max_seconds, b.limits.video_max_mb);

  // ---------------------------------------------------------------- start
  const initial = useMemo<{ draft: Draft; restored: boolean }>(() => {
    if (editing) return { draft: fromPost(editing), restored: false };
    const fresh = !!(start?.memory || start?.shared || start?.forUser || start?.file);
    const kept = fresh ? null : loadDraft();
    const d: Draft = kept ?? { ...EMPTY };
    // A kept draft's groups: only ones you're still in.
    if (Array.isArray(d.audience)) {
      const still = d.audience.filter((id) => b.groups.some((g) => g.id === id));
      d.audience = still.length ? still : null;
    }
    if (start?.group && b.groups.some((g) => g.id === start.group)) d.audience = [start.group];
    if (!d.audience) {
      const last = b.profile.last_groups;
      const known = Array.isArray(last) ? last.filter((id) => b.groups.some((g) => g.id === id)) : [];
      d.audience = Array.isArray(last) && known.length ? known : "all";
    }
    return { draft: d, restored: !!kept };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<Draft>(initial.draft);
  const [restored, setRestored] = useState(initial.restored);
  const [active, setActive] = useState(0);
  const [sheet, setSheet] = useState<null | "audience" | "place" | "life" | "poll">(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urls = useRef<string[]>([]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const step = draft.step;
  const picks = draft.picks;
  const audience: Audience = draft.audience ?? "all";
  const set = useCallback((patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch })), []);
  const setPicks = useCallback((fn: (p: Pick[]) => Pick[]) => setDraft((d) => ({ ...d, picks: fn(d.picks) })), []);
  const go = (s: Step) => {
    set({ step: s });
    scrollPorchTo(0);
  };

  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
    },
    [],
  );

  // Kept on this device as you go (a new post only), and on the way out
  // unless it was posted or thrown away.
  const finished = useRef(false);
  useEffect(() => {
    if (editing) return;
    const t = window.setTimeout(() => saveDraft(draft), 400);
    return () => window.clearTimeout(t);
  }, [draft, editing]);
  useEffect(
    () => () => {
      if (!editing && !finished.current) saveDraft(draftRef.current);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---------------------------------------------------------------- uploads
  const addFiles = useCallback(
    async (files: File[]) => {
      const room = maxMedia - draftRef.current.picks.length;
      if (room <= 0) {
        toast.info(`A post can have up to ${maxMedia} photos and videos.`);
        return;
      }
      if (files.length > room) toast.info(`A post can have up to ${maxMedia}. The first ${room} were added.`);
      const ok: File[] = [];
      for (const f of files.slice(0, room)) {
        if (!f.type.startsWith("image/") && !f.type.startsWith("video/")) {
          toast.error(`“${f.name}” isn't a photo or a video.`);
          continue;
        }
        if (f.type.startsWith("video/")) {
          const secs = await videoSeconds(f);
          if (f.size > b.limits.video_max_mb * 1024 * 1024 || (secs !== null && secs > b.limits.video_max_seconds)) {
            toast.error(limitWords);
            continue;
          }
        }
        ok.push(f);
      }
      if (!ok.length) return;
      const ids = startUploads({ files: ok, scope: "mine", folderId: null, route: "camera" });
      const added: Pick[] = ok.map((f, i) => {
        const localUrl = URL.createObjectURL(f);
        urls.current.push(localUrl);
        return {
          key: newKey(),
          fileId: null,
          taskId: ids[i],
          localUrl,
          kind: f.type.startsWith("video/") ? "video" : "image",
          name: f.name,
          width: null,
          height: null,
          durationMs: null,
          thumbhash: null,
          edit: null,
          alt: "",
          altTouched: false,
          progress: 0,
        };
      });
      setPicks((ps) => [...ps, ...added]);
    },
    [b.limits, limitWords, maxMedia, setPicks, startUploads],
  );

  // Follow the uploads: progress, then the library file (the same one if it
  // was there already), or what went wrong.
  useEffect(() => {
    setDraft((d) => {
      let changed = false;
      let next = d.picks.map((p) => {
        if (!p.taskId || p.fileId || p.error) return p;
        const t = tasks.find((x) => x.id === p.taskId);
        if (!t) return p;
        if (t.status === "done" && t.result) {
          changed = true;
          return { ...p, fileId: t.result.id, progress: 1 };
        }
        if (t.status === "error" || t.status === "cancelled") {
          changed = true;
          return { ...p, error: t.status === "cancelled" ? "The upload was stopped." : t.error || "The upload failed." };
        }
        const prog = t.size ? t.uploaded / t.size : 0;
        if (Math.abs(prog - (p.progress ?? 0)) > 0.02) {
          changed = true;
          return { ...p, progress: prog };
        }
        return p;
      });
      if (!changed) return d;
      // A photo uploaded twice is one library file: keep it once.
      const seen = new Set<string>();
      next = next.filter((p) => !p.fileId || (seen.has(p.fileId) ? false : (seen.add(p.fileId), true)));
      return { ...d, picks: next };
    });
  }, [tasks]);

  // ---------------------------------------------------------------- ways in
  const began = useRef(false);
  useEffect(() => {
    if (began.current || editing) return;
    began.current = true;
    if (start?.memory) {
      void memoriesApi
        .get(start.memory)
        .then((m) => {
          const own = m.items.filter((p) => p.mine !== false);
          if (own.length > maxMedia) toast.info(`A post can have up to ${maxMedia}. The first ${maxMedia} of this memory were picked.`);
          setDraft((d) => ({
            ...d,
            step: own.length ? "arrange" : "pick",
            memoryId: m.id,
            body: d.body || m.title,
            picks: own.slice(0, maxMedia).map(libraryPick),
          }));
        })
        .catch(() => toast.error("That memory isn't there any more."));
    }
    if (start?.file) {
      void photosApi
        .items([start.file])
        .then((items) => {
          const own = items.filter((p) => p.mine !== false);
          if (!own.length) throw new Error("gone");
          setDraft((d) => ({ ...d, step: "arrange", picks: own.map(libraryPick) }));
        })
        .catch(() => toast.error("That photo or video isn't in your library any more."));
    }
    if (start?.forUser) {
      // A birthday post: "Happy birthday @sam! 🎂", mentioning them.
      void porchApi
        .profile(start.forUser)
        .then((p) => {
          if (p.is_me) return;
          const who = p.user;
          setDraft((d) => ({
            ...d,
            step: d.picks.length ? d.step : "share",
            body: d.body || `Happy birthday @${who.username}! 🎂`,
            mentions: d.mentions.some((m) => m.id === who.id) ? d.mentions : [...d.mentions, who],
          }));
        })
        .catch(() => toast.error("That person isn't on Porch for you."));
    }
    if (start?.shared) {
      void import("@/lib/shareTargetStash").then(async ({ takeShared }) => {
        const got = await takeShared("porch");
        if (got.text) setDraft((d) => ({ ...d, body: d.body ? `${d.body}\n${got.text}` : got.text }));
        if (got.files.length) {
          await addFiles(got.files);
          set({ step: "arrange" });
        } else if (got.text) set({ step: "share" });
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- picking
  const toggle = (p: PhotoItem) => {
    if (picks.some((x) => x.fileId === p.id)) {
      setPicks((ps) => ps.filter((x) => x.fileId !== p.id));
      return;
    }
    if (picks.length >= maxMedia) {
      toast.info(`A post can have up to ${maxMedia} photos and videos.`);
      return;
    }
    if (p.kind === "video" && p.duration_ms && p.duration_ms > maxVideoMs) {
      toast.error(limitWords);
      return;
    }
    setPicks((ps) => [...ps, libraryPick(p)]);
  };

  // ---------------------------------------------------------------- what Photos knows
  const fileIds = useMemo(() => picks.map((p) => p.fileId).filter((x): x is string => !!x), [picks]);
  const fileKey = useMemo(() => [...fileIds].sort().join(","), [fileIds]);
  const info = useQuery({
    queryKey: ["porch", "compose", "files", fileKey],
    queryFn: () => porchApi.composeFiles(fileKey.split(",")),
    enabled: !!fileKey,
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (!info.data) return;
    const caps = new Map(info.data.map((f) => [f.file_id, f.caption]));
    setPicks((ps) => {
      let changed = false;
      const next = ps.map((p) => {
        const cap = p.fileId ? caps.get(p.fileId) : null;
        if (!cap || p.altTouched || p.alt) return p;
        changed = true;
        return { ...p, alt: cap };
      });
      return changed ? next : ps;
    });
  }, [info.data, setPicks]);
  const photoPlaces = useMemo(() => {
    const seen = new Set<string>();
    const out: { name: string; address: string | null; lat: number; lon: number }[] = [];
    for (const f of info.data ?? []) {
      if (!f.place || seen.has(f.place.name)) continue;
      seen.add(f.place.name);
      out.push(f.place);
    }
    return out;
  }, [info.data]);

  // ---------------------------------------------------------------- who'd see it
  const audIds = useMemo(() => (editing ? [] : audienceIds(audience, b.groups)), [editing, audience, b.groups]);
  const people = useQuery({
    queryKey: ["porch", "people", "audience", editing ? `post:${editing.id}` : audIds.join(",")],
    queryFn: () => (editing ? porchApi.people("", { post: editing.id }) : porchApi.people("", { groups: audIds })),
    enabled: !!editing || audIds.length > 0,
    staleTime: 60_000,
  });

  // ---------------------------------------------------------------- face suggestions for tags
  // Faces in your photos that are people who'd see the post — only when
  // you and they both turned "Suggest tags from my faces" on.
  const photoIds = useMemo(() => picks.filter((p) => p.kind === "image" && p.fileId).map((p) => p.fileId as string), [picks]);
  const suggest = useQuery({
    queryKey: ["porch", "compose", "faces", photoIds.join(","), editing ? `post:${editing.id}` : audIds.join(",")],
    queryFn: () => porchApi.tagSuggestions(editing ? { file_ids: photoIds, post_id: editing.id } : { file_ids: photoIds, groups: audIds }),
    enabled: b.profile.face_suggestions && photoIds.length > 0 && (step === "arrange" || step === "share") && (!!editing || audIds.length > 0),
    staleTime: 5 * 60_000,
  });

  // ---------------------------------------------------------------- link preview (text posts)
  const linkUrl = picks.length ? null : firstLink(draft.body);
  useEffect(() => {
    if (!linkUrl) {
      if (draft.link) set({ link: null });
      return;
    }
    if (draft.link?.url === linkUrl || draft.linkDismissed === linkUrl) return;
    let off = false;
    const t = window.setTimeout(() => {
      linksApi
        .unfurl(linkUrl)
        .then((p) => {
          if (off) return;
          set({ link: { url: linkUrl, title: p.title ?? "", description: p.description ?? "", site_name: p.site_name ?? "" } });
        })
        .catch(() => {
          if (!off) set({ link: { url: linkUrl, title: "", description: "", site_name: "" } });
        });
    }, 700);
    return () => {
      off = true;
      window.clearTimeout(t);
    };
  }, [linkUrl, draft.link, draft.linkDismissed, set]);

  // ---------------------------------------------------------------- post
  const uploading = picks.filter((p) => !p.fileId && !p.error).length;
  const failed = picks.filter((p) => p.error);
  const storageFull = failed.some((p) => /storage|quota|space|full/i.test(p.error ?? ""));
  const empty = !picks.length && !draft.body.trim() && !draft.life && !draft.link && !draft.poll;
  const pollIssue = pollProblem(draft);
  const dirty = editing ? JSON.stringify(fromPost(editing)) !== JSON.stringify({ ...draft, step: "share" }) : hasContent(draft);

  const submit = useCallback(async () => {
    const d = draftRef.current;
    setBusy(true);
    setError(null);
    const everyoneHere = people.data ?? [];
    // Anyone named with @ who'll see it is mentioned, picked from the list or not.
    const mentions: PorchUser[] = [...d.mentions];
    for (const u of everyoneHere) if (!mentions.some((m) => m.id === u.id) && mentionedIn(d.body, u)) mentions.push(u);
    const media = d.picks.map((p) => ({
      ...(p.mediaId ? { id: p.mediaId } : { file_id: p.fileId as string }),
      alt_text: p.alt.trim(),
      edit: p.kind === "image" ? p.edit : null,
      // Only people who can see it are asked (the server checks again).
      ...(p.kind === "image" ? { tags: (p.tags ?? []).map((t) => ({ user_id: t.user.id, x: t.x, y: t.y })) } : {}),
    }));
    const kind = d.life ? "life_event" : d.picks.length ? "photo" : d.poll ? "poll" : "text";
    try {
      if (editing) {
        const post = await porchApi.updatePost(editing.id, {
          body: d.body,
          ...(editing.kind === "text" ? {} : { media }),
          place: d.place,
          link: d.picks.length ? null : d.link,
          ...(editing.kind === "life_event" && d.life ? { life_event: d.life } : {}),
          mentions: mentions.map((m) => m.id),
        });
        putPost(qc, post.id, post);
        toast.success("Post updated.");
        navigate(`/porch/p/${post.id}`, { replace: true });
        return;
      }
      const groups = d.audience ?? "all";
      const post = await porchApi.createPost({
        kind,
        body: d.body,
        groups,
        media,
        place: d.place,
        link: d.picks.length ? null : d.link,
        life_event: d.life,
        poll: kind === "poll" && d.poll ? { options: d.poll.options.map((o) => o.trim()).filter(Boolean), closes: d.poll.closes } : null,
        from_memory_id: d.memoryId,
        mentions: mentions.map((m) => m.id),
      });
      finished.current = true;
      clearDraft();
      setDraft({ ...EMPTY });
      putPost(qc, post.id, post);
      void qc.invalidateQueries({ queryKey: LISTS });
      void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      toast.success(post.groups.length ? `Posted to ${post.groups.map((g) => g.name).join(", ")}.` : "Posted.");
      const one = Array.isArray(groups) && groups.length === 1 && start?.group === groups[0] ? groups[0] : null;
      navigate(one ? `/porch/g/${one}` : "/porch/", { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't post."));
    } finally {
      setBusy(false);
      setWaiting(false);
    }
  }, [editing, navigate, people.data, qc, start?.group]);

  const post = () => {
    if (failed.length) {
      setError(failed.length === 1 ? "One photo didn't upload. Take it out, or try again." : `${failed.length} photos didn't upload. Take them out, or try again.`);
      return;
    }
    if (uploading) {
      setWaiting(true);
      return;
    }
    void submit();
  };
  useEffect(() => {
    if (waiting && uploading === 0 && !busy) {
      if (failed.length) {
        setWaiting(false);
        setError("Some photos didn't upload. Take them out, or try again.");
      } else void submit();
    }
  }, [waiting, uploading, busy, failed.length, submit]);

  // ---------------------------------------------------------------- leaving
  const close = async () => {
    if (editing) {
      if (dirty && !(await confirm({ title: "Leave without saving?", message: "Your changes to this post will be lost.", confirmLabel: "Leave", danger: true }))) return;
      navigate(`/porch/p/${editing.id}`);
      return;
    }
    if (hasContent(draft)) toast.info("Kept as a draft. It'll be here next time.");
    window.history.length > 1 ? navigate(-1) : navigate("/porch/");
  };
  const throwAway = async () => {
    if (!(await confirm({ title: "Throw this post away?", message: "The photos stay in your Photos library.", confirmLabel: "Throw away", danger: true }))) return;
    clearDraft();
    setDraft({ ...EMPTY, audience: draft.audience });
    setRestored(false);
    setActive(0);
  };
  const removeFailed = () => {
    setPicks((ps) => ps.filter((p) => !p.error));
    setError(null);
  };

  // ---------------------------------------------------------------- drawing
  const back = (): (() => void) | null => {
    if (editing) {
      if (step === "share") return null;
      return () => go(step === "pick" ? (picks.length ? "arrange" : "share") : "share");
    }
    if (step === "pick") return null;
    if (step === "arrange") return () => go("pick");
    return () => go(picks.length ? "arrange" : "pick");
  };
  const backFn = back();
  const nextLabel = step === "share" ? (editing ? "Save" : "Post") : "Next";
  const canNext = step === "pick" ? picks.length > 0 : step === "arrange" ? picks.length > 0 : !empty && !busy && !waiting && !pollIssue;
  const onNext = () => {
    if (step === "pick") go("arrange");
    else if (step === "arrange") go("share");
    else post();
  };
  const title = editing ? (step === "share" ? "Edit post" : STEP_TITLES[step]) : STEP_TITLES[step];
  const stepNo = step === "pick" ? 1 : step === "arrange" ? 2 : 3;

  const headBtn =
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]";

  return (
    <div className={cn("mx-auto flex w-full flex-col", step === "share" ? "max-w-[640px]" : "max-w-3xl", isPhone ? "min-h-full" : "pb-10")}>
      <header className={cn("sticky top-0 z-20 flex h-14 shrink-0 items-center gap-1 bg-[var(--bg)] px-2 md:px-0", isPhone && "border-b border-[var(--border)]")}>
        {backFn ? (
          <button type="button" aria-label="Back" onClick={backFn} className={headBtn}>
            <ArrowLeft className="h-5 w-5" />
          </button>
        ) : (
          <button type="button" aria-label={editing ? "Close without saving" : "Close"} onClick={() => void close()} className={headBtn}>
            <X className="h-5 w-5" />
          </button>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-lg font-bold leading-tight text-[var(--text)]">{title}</h1>
          {!editing && (
            <span className="text-xs text-[var(--text-muted)]">
              {picks.length || step !== "share" ? `Step ${stepNo} of 3` : "A text post"}
              {picks.length > 0 && ` · ${picks.length} of ${maxMedia}`}
            </span>
          )}
        </div>
        <ItemButton
          variant="primary"
          onClick={onNext}
          disabled={!canNext}
          className="min-w-[5.5rem] !transition-none disabled:bg-[var(--surface-2)] disabled:text-[var(--text-muted)] disabled:opacity-100 disabled:shadow-none"
          icon={(busy || waiting) && step === "share" ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}
        >
          {nextLabel}
        </ItemButton>
      </header>

      {restored && !editing && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-xl bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text)] md:mx-0">
          <span className="flex-1">Here's the post you started before.</span>
          <button type="button" onClick={() => void throwAway()} className="h-9 rounded-lg px-2 font-medium text-[var(--accent-text)] hover:bg-[var(--hover)]">
            Throw it away
          </button>
          <button type="button" aria-label="Hide this note" onClick={() => setRestored(false)} className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {storageFull && (
        <div className="mx-3 mb-2 md:mx-0">
          <Callout tone="danger">Your storage is full. Photos already in your library can still be posted.</Callout>
        </div>
      )}

      <div className={cn("flex-1", isPhone && "pb-24")}>
        {step === "pick" && (
          <PickStep
            picks={picks}
            onToggle={toggle}
            onFiles={(f) => void addFiles(f)}
            onTextPost={() => go("share")}
            isPhone={isPhone}
            maxVideoMs={maxVideoMs}
            showTextLink={!picks.length && !editing}
          />
        )}
        {step === "arrange" && picks.length > 0 && (
          <ArrangeStep
            picks={picks}
            setPicks={setPicks}
            active={active}
            setActive={setActive}
            onAdd={() => go("pick")}
            maxMedia={maxMedia}
            isPhone={isPhone}
            audience={people.data ?? []}
            audienceReady={people.isSuccess}
            suggestions={suggest.data?.suggestions ?? []}
          />
        )}
        {step === "arrange" && !picks.length && (
          <p className="px-3 py-10 text-center text-sm text-[var(--text-muted)]">
            No photos picked.{" "}
            <button type="button" className="font-medium text-[var(--accent-text)] underline" onClick={() => go("pick")}>
              Pick some
            </button>
          </p>
        )}
        {step === "share" && (
          <ShareStep
            picks={picks}
            onEditPhotos={() => go("arrange")}
            onAddPhotos={() => go("pick")}
            audience={audience}
            groups={b.groups}
            fixedGroups={editing ? editing.groups : null}
            everyoneCount={b.everyone.member_count}
            onAudience={() => setSheet("audience")}
            body={draft.body}
            onBody={(v) => set({ body: v })}
            mentions={draft.mentions}
            onMentions={(m) => set({ mentions: m })}
            audiencePeople={people.data ?? []}
            audienceReady={people.isSuccess}
            link={draft.link}
            onDropLink={() => set({ link: null, linkDismissed: draft.link?.url ?? null })}
            place={draft.place}
            onPlace={() => setSheet("place")}
            onClearPlace={() => set({ place: null })}
            life={draft.life}
            onLife={() => setSheet("life")}
            onClearLife={() => set({ life: null })}
            canPhotos={!editing || (editing.kind !== "text" && editing.kind !== "poll")}
            canLife={!editing || editing.kind === "life_event"}
            poll={draft.poll}
            onPoll={() => setSheet("poll")}
            onClearPoll={() => set({ poll: null })}
            canPoll={!editing}
            pollLocked={editing?.kind === "poll"}
            onTags={() => go("arrange")}
          />
        )}

        {step === "share" && pollIssue && !empty && (
          <p className="mx-3 mt-3 text-sm text-[var(--text-muted)] md:mx-0" aria-live="polite">
            {pollIssue}
          </p>
        )}

        {step === "share" && (waiting || error) && (
          <div className="mx-3 mt-4 md:mx-0" aria-live="polite">
            {waiting && !error ? (
              <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                {uploading === 1 ? "Posting when your upload finishes…" : `Posting when your ${uploading} uploads finish…`}
              </p>
            ) : (
              <Callout tone="danger">
                <div className="flex flex-col items-start gap-2">
                  <span>
                    {error}
                    {!failed.length && !editing && " Your photos are safe in Photos."}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {failed.length > 0 && (
                      <ItemButton size="sm" variant="secondary" onClick={removeFailed}>
                        {failed.length === 1 ? "Take it out" : "Take them out"}
                      </ItemButton>
                    )}
                    {!failed.length && (
                      <ItemButton size="sm" variant="secondary" onClick={post}>
                        Try again
                      </ItemButton>
                    )}
                  </div>
                </div>
              </Callout>
            )}
          </div>
        )}

        {step === "share" && !editing && hasContent(draft) && (
          <div className="mt-6 flex justify-center">
            <ItemButton variant="ghost" size="sm" onClick={() => void throwAway()} className="text-[var(--text-muted)]">
              Throw this post away
            </ItemButton>
          </div>
        )}
      </div>

      {/* The picks so far, while picking: order, upload progress, Next. */}
      {step === "pick" && picks.length > 0 && (
        <div className={cn("sticky bottom-0 z-20 flex items-center gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2", !isPhone && "rounded-t-xl")}>
          <ol aria-label="Picked" className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none]">
            {picks.map((p, i) => (
              <li key={p.key} className="relative shrink-0">
                <PickImage pick={p} label={`Picked ${i + 1}`} className="h-12 w-12 rounded-lg" />
                <span aria-hidden className="absolute left-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-black/60 px-0.5 text-[10px] font-bold text-white">
                  {i + 1}
                </span>
              </li>
            ))}
          </ol>
          <ItemButton variant="primary" onClick={() => go("arrange")}>
            Next
          </ItemButton>
        </div>
      )}

      <AudienceSheet open={sheet === "audience"} onClose={() => setSheet(null)} value={audience} onChange={(a) => set({ audience: a })} groups={b.groups} />
      <PlaceSheet open={sheet === "place"} onClose={() => setSheet(null)} onPick={(p) => set({ place: p })} fromPhotos={photoPlaces} />
      <PollEditor open={sheet === "poll"} onClose={() => setSheet(null)} value={draft.poll} onSave={(v) => set({ poll: v, life: null })} onRemove={() => set({ poll: null })} />
      <LifeEventEditor open={sheet === "life"} onClose={() => setSheet(null)} value={draft.life} onSave={(v) => set({ life: v, poll: null })} onRemove={() => set({ life: null })} />
    </div>
  );
}

function libraryPick(p: PhotoItem): Pick {
  return {
    key: newKey(),
    fileId: p.id,
    thumb: p.thumb,
    kind: p.kind,
    name: p.filename,
    width: p.width,
    height: p.height,
    durationMs: p.duration_ms,
    thumbhash: p.thumbhash,
    edit: null,
    alt: "",
    altTouched: false,
    tags: [],
  };
}
