import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, EyeOff, MoreHorizontal, PawPrint, UserRound, X } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { peopleApi, type ReviewEntry, type Subject, type SubjectKind } from "@/api/people";
import type { PhotoItem } from "@/api/photos";
import { PhotoTile } from "@/components/photos/PhotoTile";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { Button } from "@/components/shared/Button";
import { justify } from "@/lib/justify";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/** People & Pets (PH-3): who's in your photos — name them once, and
 *  "Who is this?" for the ones not named yet. */
export function PeoplePage() {
  const [params, setParams] = useSearchParams();
  const kind: SubjectKind = params.get("kind") === "pet" ? "pet" : "person";
  const [showHidden, setShowHidden] = useState(false);
  const { data: list, isLoading } = useQuery({
    queryKey: ["people", kind, showHidden],
    queryFn: () => peopleApi.list(kind, showHidden),
  });
  const { data: review } = useQuery({ queryKey: ["people", "review"], queryFn: peopleApi.review });
  const named = (list ?? []).filter((p) => p.name);
  const unnamed = (review ?? []).filter((r) => r.kind === kind);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <h1 className="mr-2 text-base font-semibold text-[var(--text)]">People &amp; pets</h1>
        <nav aria-label="People or pets" className="flex gap-1">
          {(
            [
              ["person", "People", UserRound],
              ["pet", "Pets", PawPrint],
            ] as const
          ).map(([k, label, Icon]) => (
            <button
              key={k}
              type="button"
              aria-current={kind === k ? "page" : undefined}
              onClick={() => setParams(k === "person" ? {} : { kind: k }, { replace: true })}
              className={cn(
                "flex items-center gap-1 rounded-full px-3 py-1 text-xs transition",
                kind === k ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]",
              )}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </nav>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden
        </label>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {unnamed.length > 0 && (
          <section aria-label="Who is this?" className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-[var(--text)]">Who is this?</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
              {unnamed.map((r) => (
                <ReviewCard key={r.id ?? `species-${r.species}`} entry={r} known={named} className="w-full" />
              ))}
            </div>
          </section>
        )}
        {isLoading ? (
          <p className="text-sm text-[var(--text-muted)]">Loading…</p>
        ) : named.length === 0 && unnamed.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            {kind === "person"
              ? "No people yet. Turn on Recognise faces in Photos settings; the people in your photos appear here as their faces are found."
              : "No pets yet. Animals are found in your photos with the photos service running; name one and the rest of its photos follow."}
          </p>
        ) : (
          <ul aria-label={kind === "person" ? "People" : "Pets"} className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-4">
            {named.map((p) => (
              <li key={p.id}>
                <Link to={`/files/photos/people/${p.id}`} className="group flex flex-col items-center gap-1.5 text-center">
                  <Avatar subject={p} size="lg" />
                  <span className="text-sm font-medium text-[var(--text)] group-hover:underline">
                    {p.name}
                    {p.me && <span className="ml-1 text-xs text-[var(--text-muted)]">(you)</span>}
                  </span>
                  {p.relationship && <span className="text-xs text-[var(--accent-text)]">{p.relationship}</span>}
                  <span className="text-xs text-[var(--text-muted)]">
                    {p.photos.toLocaleString()} {p.photos === 1 ? "photo" : "photos"}
                    {p.hidden && " · hidden"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Avatar({ subject, size }: { subject: { cover: string | null; name: string | null }; size: "lg" | "md" }) {
  const cls = size === "lg" ? "h-24 w-24" : "h-14 w-14";
  return subject.cover ? (
    <img src={subject.cover} alt="" loading="lazy" className={cn(cls, "rounded-full object-cover")} />
  ) : (
    <span className={cn(cls, "flex items-center justify-center rounded-full bg-[var(--hover)] text-[var(--text-muted)]")}>
      <UserRound className="h-6 w-6" />
    </span>
  );
}

/** One unnamed person (a cluster) or a species of animal nobody's named
 *  ("a dog in 21 photos" — maybe more than one dog). Untick any that
 *  aren't them, then say who: one of your people or pets already named
 *  (a tap), or a new name. For a pet the rest of its photos follow on
 *  their own, from these as examples. */
export function ReviewCard({ entry, known, className }: { entry: ReviewEntry; known: Subject[]; className?: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<Set<string>>(new Set()); // unticked: not them
  const chosen = entry.samples.filter((s) => !left.has(s.id));
  const cover = chosen[0]?.crop ?? entry.cover;
  const isPerson = entry.kind === "person";
  // The same species first ("Bumi" for a dog), then the rest.
  const picks = known
    .filter((k) => k.name)
    .sort((x, y) => Number(y.species === entry.species) - Number(x.species === entry.species))
    .slice(0, 8);
  const done = (label: string) => {
    void qc.invalidateQueries({ queryKey: ["people"] });
    toast.success(label);
  };

  const save = async (who: { person_id?: string; name?: string }, label: string) => {
    if (!chosen.length) return;
    setBusy(true);
    try {
      if (entry.id) {
        // A cluster: the unticked ones aren't this person, the rest are.
        for (const s of entry.samples) if (left.has(s.id)) await peopleApi.notThem(s.id, entry.id);
        const same = who.person_id ?? known.find((k) => k.name?.toLowerCase() === who.name?.toLowerCase())?.id;
        if (same) await peopleApi.merge(entry.id, same);
        else await peopleApi.update(entry.id, { name: who.name ?? null });
      } else {
        await peopleApi.nameMany(chosen.map((s) => s.id), who);
      }
      setName("");
      setLeft(new Set());
      done(isPerson ? `That's ${label}.` : `That's ${label} — the rest of their photos will follow.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save that."));
    } finally {
      setBusy(false);
    }
  };

  const hide = async () => {
    if (!entry.id) return;
    try {
      await peopleApi.update(entry.id, { hidden: true });
      done("Hidden — they won't be asked about again.");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't hide them."));
    }
  };

  const title = isPerson
    ? `Someone in ${entry.photos.toLocaleString()} ${entry.photos === 1 ? "photo" : "photos"}`
    : `A ${entry.species ?? "pet"} in ${entry.photos.toLocaleString()} ${entry.photos === 1 ? "photo" : "photos"}`;

  return (
    <article
      aria-label={title}
      className={cn("flex flex-col gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3", className ?? "w-80")}
    >
      <div className="flex items-center gap-3">
        {cover ? (
          <img src={cover} alt="" className="h-14 w-14 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[var(--hover)] text-[var(--text-muted)]">
            {isPerson ? <UserRound className="h-6 w-6" /> : <PawPrint className="h-6 w-6" />}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--text)]">{title}</p>
          {entry.samples.length > 1 && <p className="text-xs text-[var(--text-muted)]">Untick any that aren't them.</p>}
        </div>
        {entry.id && (
          <button
            type="button"
            onClick={() => void hide()}
            title="Don't ask about them again"
            className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]"
          >
            <EyeOff className="h-3.5 w-3.5" /> Hide
          </button>
        )}
      </div>

      <ul className="grid grid-cols-6 gap-1" aria-label="Their photos">
        {entry.samples.map((s) => {
          const out = left.has(s.id);
          return (
            <li key={s.id}>
              <button
                type="button"
                aria-pressed={!out}
                aria-label={out ? "Not them — tick again" : "Them — untick if not"}
                onClick={() =>
                  setLeft((cur) => {
                    const next = new Set(cur);
                    if (next.has(s.id)) next.delete(s.id);
                    else next.add(s.id);
                    return next;
                  })
                }
                className="relative block aspect-square w-full overflow-hidden rounded-md bg-[var(--hover)]"
              >
                {s.crop && <img src={s.crop} alt="" loading="lazy" className={cn("h-full w-full object-cover transition", out && "opacity-25 grayscale")} />}
                {out && (
                  <span className="absolute inset-0 flex items-center justify-center text-[var(--text)]">
                    <X className="h-4 w-4" />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {picks.length > 0 && (
        <div>
          <p className="mb-1 text-xs text-[var(--text-muted)]">{isPerson ? "It's…" : "It's…"}</p>
          <div className="flex flex-wrap gap-1">
            {picks.map((k) => (
              <button
                key={k.id}
                type="button"
                disabled={busy || !chosen.length}
                onClick={() => void save({ person_id: k.id! }, k.name!)}
                className="flex items-center gap-1.5 rounded-full border border-[var(--border)] py-0.5 pl-0.5 pr-2.5 text-xs text-[var(--text)] hover:border-[var(--accent)] hover:bg-[var(--hover)] disabled:opacity-50"
              >
                {k.cover ? (
                  <img src={k.cover} alt="" className="h-5 w-5 rounded-full object-cover" />
                ) : (
                  <span className="h-5 w-5 rounded-full bg-[var(--hover)]" />
                )}
                {k.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (n) void save({ name: n }, n);
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={picks.length ? "Or someone new…" : isPerson ? "Who is this?" : `Name this ${entry.species ?? "pet"}`}
          aria-label={isPerson ? "Who is this?" : `Name this ${entry.species ?? "pet"}`}
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs"
        />
        <Button size="sm" variant="secondary" type="submit" disabled={busy || !name.trim() || !chosen.length} aria-label="Save name">
          <Check className="h-3.5 w-3.5" />
        </Button>
      </form>
    </article>
  );
}

/** One person or pet: their photos, and naming, hiding, "this is me",
 *  merging. */
export function PersonPage() {
  const { personId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pages = useInfiniteQuery({
    queryKey: ["people", "one", personId],
    queryFn: ({ pageParam }) => peopleApi.get(personId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
  const first = pages.data?.pages[0];
  const person = first?.person;
  const kind = first?.kind ?? "person";
  const items = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);
  const rows = useMemo(
    () => justify(items.map((p) => ({ aspect: p.width && p.height ? p.width / p.height : null })), { width, targetHeight: width < 640 ? 110 : 190, gap: 4 }),
    [items, width],
  );
  const [viewing, setViewing] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [menu, setMenu] = useState(false);
  const [merging, setMerging] = useState(false);
  const [view, setView] = useState<"photos" | "faces">("photos");
  const { data: others } = useQuery({ queryKey: ["people", kind, false], queryFn: () => peopleApi.list(kind), enabled: merging });

  const refresh = () => void qc.invalidateQueries({ queryKey: ["people"] });
  const update = async (patch: Parameters<typeof peopleApi.update>[1], done?: string) => {
    try {
      await peopleApi.update(personId, patch);
      refresh();
      if (done) toast.success(done);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save that."));
    }
  };

  if (pages.error) return <p className="p-6 text-sm text-[var(--text-muted)]">They aren't in your photos any more.</p>;
  if (!person) return <p className="p-6 text-sm text-[var(--text-muted)]">Loading…</p>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <Link to={`/files/photos/people${kind === "pet" ? "?kind=pet" : ""}`} aria-label="Back to people" className="rounded p-1 hover:bg-[var(--hover)]">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <Avatar subject={person} size="md" />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setEditing(false);
                void update({ name: name.trim() || null });
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setEditing(false)}
                aria-label="Name"
                className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-base font-semibold"
              />
            </form>
          ) : (
            <h1 className="truncate text-base font-semibold text-[var(--text)]">
              <button type="button" onClick={() => { setName(person.name ?? ""); setEditing(true); }} className="hover:underline">
                {person.name ?? "Add a name"}
              </button>
              {person.me && <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">This is you</span>}
            </h1>
          )}
          <p className="text-xs text-[var(--text-muted)]">
            {person.photos.toLocaleString()} {person.photos === 1 ? "photo" : "photos"}
            {person.species ? ` · ${person.species}` : ""}
            {person.hidden ? " · hidden from People" : ""}
          </p>
          {kind === "person" && !person.me && <Relationship id={personId} value={person.relationship ?? null} onSaved={refresh} />}
        </div>
        <div className="relative">
          <button type="button" aria-label="More" onClick={() => setMenu((m) => !m)} className="rounded p-1.5 hover:bg-[var(--hover)]">
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menu && (
            <div role="menu" className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-[var(--border)] bg-[var(--surface)] p-1 text-sm shadow-lg">
              {kind === "person" && (
                <button type="button" role="menuitem" className="w-full rounded px-2 py-1.5 text-left hover:bg-[var(--hover)]"
                  onClick={() => { setMenu(false); void update({ me: !person.me }, person.me ? "Not you, then." : "That's you."); }}>
                  {person.me ? "This isn't me" : "This is me"}
                </button>
              )}
              <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--hover)]"
                onClick={() => { setMenu(false); void update({ hidden: !person.hidden }, person.hidden ? "Shown in People again." : "Hidden from People."); }}>
                <EyeOff className="h-3.5 w-3.5" /> {person.hidden ? "Show in People" : "Hide from People"}
              </button>
              <button type="button" role="menuitem" className="w-full rounded px-2 py-1.5 text-left hover:bg-[var(--hover)]"
                onClick={() => {
                  setMenu(false);
                  const on = person.memories === false;
                  void update({ memories: on }, on ? "Memories of them will show again." : "No more memories of them.");
                }}>
                {person.memories === false ? "Show memories of them" : "Don't show memories of them"}
              </button>
              <button type="button" role="menuitem" className="w-full rounded px-2 py-1.5 text-left hover:bg-[var(--hover)]"
                onClick={() => { setMenu(false); setMerging(true); }}>
                Same {kind === "pet" ? "pet" : "person"} as…
              </button>
            </div>
          )}
        </div>
      </header>
      {merging && (
        <div className="border-b border-[var(--border)] px-4 py-2 text-sm">
          <span className="mr-2 text-[var(--text-muted)]">Merge into:</span>
          {(others ?? []).filter((o) => o.id !== personId && o.name).map((o) => (
            <button key={o.id} type="button" className="mr-2 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs hover:bg-[var(--hover)]"
              onClick={async () => {
                try {
                  await peopleApi.merge(personId, o.id!);
                  refresh();
                  toast.success(`Merged into ${o.name}.`);
                  navigate(`/files/photos/people/${o.id}`, { replace: true });
                } catch (e) {
                  toast.error(apiErrorMessage(e, "Couldn't merge them."));
                }
              }}>
              {o.name}
            </button>
          ))}
          <button type="button" className="text-xs text-[var(--text-muted)] hover:underline" onClick={() => setMerging(false)}>Cancel</button>
        </div>
      )}
      <nav aria-label="Photos or faces" className="flex gap-1 border-b border-[var(--border)] px-4 py-1.5">
        {(["photos", "faces"] as const).map((v) => (
          <button key={v} type="button" aria-current={view === v ? "page" : undefined} onClick={() => setView(v)}
            className={cn("rounded-full px-3 py-1 text-xs", view === v ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]")}>
            {v === "photos" ? "Photos" : kind === "pet" ? "Each photo" : "Faces"}
          </button>
        ))}
      </nav>
      {view === "faces" ? (
        <FacesView id={personId} kind={kind} onMoved={refresh} />
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div ref={setBox} className="flex flex-col gap-1" aria-label="Their photos">
          {rows.map((r, ri) => (
            <div key={ri} className="flex gap-1" style={{ height: r.height }}>
              {r.items.map((idx, k) => {
                const p = items[idx];
                return (
                  <PhotoTile key={p.id} photo={p} width={r.widths[k]} height={r.height} selected={false} selecting={false}
                    onToggle={() => {}} onOpen={(ph: PhotoItem) => setViewing(ph.id)} />
                );
              })}
            </div>
          ))}
        </div>
        {pages.hasNextPage && (
          <div className="mt-4 text-center">
            <Button size="sm" variant="secondary" onClick={() => void pages.fetchNextPage()} loading={pages.isFetchingNextPage}>
              More photos
            </Button>
          </div>
        )}
      </div>
      )}
      {viewing && (
        <PhotoViewer items={items} startId={viewing} loadMore={async () => []} onClose={() => { setViewing(null); refresh(); }} onChanged={refresh} />
      )}
    </div>
  );
}

const RELATIONS = ["my wife", "my husband", "my partner", "my son", "my daughter", "Mum", "Dad", "my brother", "my sister",
  "Grandma", "Grandpa", "a friend", "a colleague"];

/** Who they are to you — your words; nobody else sees them. */
function Relationship({ id, value, onSaved }: { id: string; value: string | null; onSaved: () => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const save = async () => {
    const next = draft.trim() || null;
    if (next === (value ?? null)) return;
    try {
      await peopleApi.setRelationship(id, next);
      onSaved();
      toast.success(next ? `Saved: ${next}.` : "Removed.");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save that."));
    }
  };
  return (
    <form className="mt-1 flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input
        list={`rel-${id}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        placeholder="Who are they to you? (only you see this)"
        aria-label="Who are they to you?"
        className="w-64 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 text-xs"
      />
      <datalist id={`rel-${id}`}>
        {RELATIONS.map((r) => <option key={r} value={r} />)}
      </datalist>
    </form>
  );
}

/** Each face (or each photo of a pet): pick the ones that are someone
 *  else and move them — they're never suggested here again. */
function FacesView({ id, kind, onMoved }: { id: string; kind: SubjectKind; onMoved: () => void }) {
  const { data, refetch } = useQuery({ queryKey: ["people", "faces", id], queryFn: () => peopleApi.faces(id) });
  const { data: others } = useQuery({ queryKey: ["people", kind, false], queryFn: () => peopleApi.list(kind) });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const move = async (to: { into?: string; name?: string }, label: string) => {
    try {
      await peopleApi.split(id, [...picked], to);
      setPicked(new Set());
      setName("");
      void refetch();
      onMoved();
      toast.success(`Moved to ${label}.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't move them."));
    }
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {picked.size > 0 && (
        <div role="toolbar" aria-label="Selected faces" className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium">{picked.size} selected — they are:</span>
          {(others ?? []).filter((o) => o.id !== id && o.name).slice(0, 12).map((o) => (
            <button key={o.id} type="button" className="rounded-full border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--hover)]"
              onClick={() => void move({ into: o.id! }, o.name!)}>
              {o.name}
            </button>
          ))}
          <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void move({ name: name.trim() }, name.trim()); }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Someone new" aria-label="Someone new"
              className="w-36 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5" />
            <Button size="sm" variant="secondary" type="submit" disabled={!name.trim()}>Move</Button>
          </form>
        </div>
      )}
      <ul aria-label="Their faces" className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
        {(data?.faces ?? []).map((f) => {
          const on = picked.has(f.id);
          return (
            <li key={f.id}>
              <button type="button" aria-pressed={on} aria-label={on ? "Deselect face" : "Select face"}
                onClick={() => setPicked((cur) => { const n = new Set(cur); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })}
                className={cn("block w-full overflow-hidden rounded-lg ring-offset-2 ring-offset-[var(--bg)]", on && "ring-2 ring-[var(--accent)]")}>
                {f.crop ? <img src={f.crop} alt="" loading="lazy" className="aspect-square w-full object-cover" /> : <span className="block aspect-square bg-[var(--hover)]" />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
