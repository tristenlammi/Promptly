import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { porchApi, type Highlight, type PorchStory } from "@/api/porch";
import { Field, ItemButton, Sheet, TextInput } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { HIGHLIGHTS_KEY, STORY_ARCHIVE_KEY } from "../../cache";
import { useSentinel } from "../../scroll";
import { LoadError } from "../ui";
import { BACKGROUND_LOOK } from "./look";
import { StoryFrame } from "./StoryFrame";

const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

export function monthOf(iso: string): string {
  return MONTH.format(new Date(iso));
}

/** Your stories by month (newest first), from the archive. */
export function useArchive() {
  const q = useInfiniteQuery({
    queryKey: STORY_ARCHIVE_KEY,
    queryFn: ({ pageParam }) => porchApi.storyArchive(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    staleTime: 30_000,
  });
  const stories = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.stories), [q.data]);
  const months = useMemo(() => {
    const out: { label: string; stories: PorchStory[] }[] = [];
    for (const s of stories) {
      const label = monthOf(s.created_at);
      if (out.length && out[out.length - 1].label === label) out[out.length - 1].stories.push(s);
      else out.push({ label, stories: [s] });
    }
    return out;
  }, [stories]);
  return { q, stories, months };
}

/** A story as a small 9:16 tile (archive, pickers). */
export function StoryTile({ story, picked, order, onClick, label }: { story: PorchStory; picked?: boolean; order?: number; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={picked}
      aria-label={label}
      className="group relative block w-full overflow-hidden rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] focus-visible:ring-offset-2"
    >
      <StoryFrame story={story} small className={cn("w-full transition", picked && "scale-[0.94] rounded-lg")} />
      <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-semibold text-white">
        {new Date(story.created_at).getDate()}
      </span>
      {picked !== undefined && (
        <span
          aria-hidden
          className={cn(
            "absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-bold",
            picked ? "border-white bg-[var(--item-accent)] text-white" : "border-white/90 bg-black/25",
          )}
        >
          {picked ? order : null}
        </span>
      )}
    </button>
  );
}

function storyLabel(s: PorchStory): string {
  const when = new Date(s.created_at).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const what = s.kind === "text" ? `Words: ${s.text}` : s.kind === "video" ? "A video" : s.alt_text ? `A photo: ${s.alt_text}` : "A photo";
  return `${what}, ${when}`;
}

/** Pick stories from your archive (in the order you tap them). */
function ArchivePicker({ picked, onToggle }: { picked: string[]; onToggle: (s: PorchStory) => void }) {
  const { q, months } = useArchive();
  const sentinel = useSentinel(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  });
  if (q.isPending) return <p className="py-6 text-center text-sm text-[var(--text-muted)]">Loading your stories…</p>;
  if (q.isError) return <LoadError what="Couldn't load your stories." onRetry={() => void q.refetch()} />;
  if (!months.length) return <p className="py-8 text-center text-sm text-[var(--text-muted)]">You haven't posted a story yet. Your stories show here after you do, even after their day is up.</p>;
  return (
    <div className="flex flex-col gap-3">
      {months.map((m) => (
        <section key={m.label} aria-label={m.label}>
          <h3 className="pb-1.5 text-sm font-semibold text-[var(--text)]">{m.label}</h3>
          <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
            {m.stories.map((s) => {
              const i = picked.indexOf(s.id);
              return (
                <li key={s.id}>
                  <StoryTile story={s} picked={i >= 0} order={i + 1} onClick={() => onToggle(s)} label={storyLabel(s)} />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <div ref={sentinel} className="h-2" />
    </div>
  );
}

/**
 * New highlight (or change one): pick stories from your archive, then a name
 * and a cover. Each story still shows only to the people in its groups.
 */
export function HighlightEditor({ open, onClose, editing, start }: { open: boolean; onClose: () => void; editing?: Highlight | null; start?: PorchStory | null }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<"pick" | "name">("pick");
  const [picked, setPicked] = useState<PorchStory[]>([]);
  const [name, setName] = useState("");
  const [cover, setCover] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setStep(editing ? "name" : "pick");
    setPicked(editing ? editing.stories : start ? [start] : []);
    setName(editing?.name ?? "");
    setCover(editing?.cover?.story_id ?? null);
  }, [open, editing, start]);
  const ids = picked.map((s) => s.id);
  const toggle = (s: PorchStory) => setPicked((p) => (p.some((x) => x.id === s.id) ? p.filter((x) => x.id !== s.id) : [...p, s]));

  const save = async () => {
    setBusy(true);
    try {
      if (editing) await porchApi.updateHighlight(editing.id, { name: name.trim(), story_ids: ids, cover_story_id: cover && ids.includes(cover) ? cover : ids[0] });
      else await porchApi.createHighlight({ name: name.trim(), story_ids: ids, cover_story_id: cover && ids.includes(cover) ? cover : ids[0] });
      void qc.invalidateQueries({ queryKey: HIGHLIGHTS_KEY });
      toast.success(editing ? "Highlight saved." : `“${name.trim()}” is on your profile.`);
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't save the highlight. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title={step === "pick" ? (editing ? "Stories in this highlight" : "New highlight: pick stories") : editing ? "Edit highlight" : "New highlight"}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          {step === "pick" ? (
            <>
              <span className="mr-auto text-xs text-[var(--text-muted)]">{ids.length ? `${ids.length} picked` : "Tap the stories to keep."}</span>
              <ItemButton variant="primary" disabled={!ids.length} onClick={() => setStep("name")}>
                Next
              </ItemButton>
            </>
          ) : (
            <>
              <ItemButton variant="ghost" onClick={() => setStep("pick")}>
                {editing ? "Change stories" : "Back"}
              </ItemButton>
              <ItemButton variant="primary" disabled={!name.trim() || !ids.length || busy} onClick={() => void save()}>
                Save
              </ItemButton>
            </>
          )}
        </div>
      }
    >
      {step === "pick" ? (
        <ArchivePicker picked={ids} onToggle={toggle} />
      ) : (
        <div className="flex flex-col gap-4">
          <Field label="Name" hint={`${name.length}/40`}>
            <TextInput data-autofocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Holidays, The kids, Garden…" />
          </Field>
          <div>
            <p className="mb-1.5 text-sm font-medium text-[var(--text)]">Cover</p>
            <div role="radiogroup" aria-label="Cover" className="flex gap-2 overflow-x-auto pb-1">
              {picked.map((s, i) => {
                const on = (cover ?? ids[0]) === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={`Story ${i + 1} as the cover`}
                    onClick={() => setCover(s.id)}
                    className={cn("relative w-16 shrink-0 overflow-hidden rounded-lg ring-2 ring-offset-2 ring-offset-[var(--bg)] focus-visible:outline-none", on ? "ring-[var(--item-accent)]" : "ring-transparent")}
                  >
                    <StoryFrame story={s} small className="w-full" />
                    {on && (
                      <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-white" aria-hidden>
                        <Check className="h-5 w-5" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            It stays on your profile. Each story in it shows only to the people in the groups it went to, so not everyone sees all of it.
          </p>
        </div>
      )}
    </Sheet>
  );
}

/** "Add to highlight": one of yours, or a new one. */
export function AddToHighlightSheet({ story, open, onClose }: { story: PorchStory | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [making, setMaking] = useState(false);
  const q = useQuery({ queryKey: HIGHLIGHTS_KEY, queryFn: porchApi.myHighlights, enabled: open, staleTime: 30_000 });
  const add = async (h: Highlight) => {
    if (!story) return;
    try {
      await porchApi.addToHighlight(h.id, story.id);
      void qc.invalidateQueries({ queryKey: HIGHLIGHTS_KEY });
      toast.success(`Added to “${h.name}”.`);
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't add it. Try again."));
    }
  };
  return (
    <>
      <Sheet open={open && !making} onClose={onClose} title="Add to highlight" size="sm">
        <ul className="-mx-2 flex flex-col">
          <li>
            <button
              type="button"
              onClick={() => setMaking(true)}
              className="flex min-h-[56px] w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-dashed border-[var(--border)] text-[var(--text-muted)]">
                <Plus className="h-5 w-5" aria-hidden />
              </span>
              <span className="text-sm font-medium text-[var(--text)]">New highlight</span>
            </button>
          </li>
          {q.isPending && <li className="px-2 py-3 text-sm text-[var(--text-muted)]">Loading…</li>}
          {(q.data ?? []).map((h) => {
            const already = !!story && h.stories.some((s) => s.id === story.id);
            return (
              <li key={h.id}>
                <button
                  type="button"
                  disabled={already}
                  onClick={() => void add(h)}
                  className="flex min-h-[56px] w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-[var(--hover)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
                >
                  <HighlightCircle h={h} size={44} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--text)]">{h.name}</span>
                    <span className="block text-xs text-[var(--text-muted)]">{already ? "Already in it" : h.count === 1 ? "1 story" : `${h.count} stories`}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Sheet>
      <HighlightEditor
        open={open && making}
        onClose={() => {
          setMaking(false);
          onClose();
        }}
        start={story}
      />
    </>
  );
}

/** A highlight's round cover. */
export function HighlightCircle({ h, size = 64 }: { h: Pick<Highlight, "cover" | "name">; size?: number }) {
  const c = h.cover;
  const bg = c?.background ? BACKGROUND_LOOK[c.background].css : undefined;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--surface-2)] ring-2 ring-[var(--border)] ring-offset-2 ring-offset-[var(--bg)]"
      style={{ width: size, height: size, background: c?.image ? undefined : bg }}
    >
      {c?.image ? (
        <img src={c.image} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-lg font-bold text-white">{h.name.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
