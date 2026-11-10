import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, EyeOff, MoreHorizontal, PawPrint, Plus, ScanFace, UserRound, X } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { PersonContact, useLinkedContact } from "@/components/photos/PersonContact";
import { usePhotosPath } from "@/components/photos/photosPath";
import { peopleApi, reviewKey, type ReviewEntry, type Subject, type SubjectKind } from "@/api/people";
import { personPath } from "@/api/peopleHub";
import { photosApi, type PhotoItem } from "@/api/photos";
import { PhotoTile } from "@/components/photos/PhotoTile";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { Skeleton } from "@/components/shared/Skeleton";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { justify } from "@/lib/justify";
import { toast } from "@/store/toastStore";
import { birthdayLabel } from "@/items/kinds/contacts/photosLink";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/* The three "people" screens have one name each: Contacts (the address
 * book), Faces (this list, in Photos) and the person page (/people/…).
 * They share a header shape: a 40px back button where there's somewhere to
 * go back to, a 15–16px semibold title, and a 40px "More" on the right. */
const HEAD_BTN = "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]";
const PILL = "inline-flex h-10 items-center gap-1 rounded-full px-3 text-xs transition md:h-8";
const PILL_ON = "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]";
const PILL_OFF = "text-[var(--text-muted)] hover:bg-[var(--hover)]";

/** Faces (PH-3): who's in your photos — name them once, and
 *  "Who is this?" for the ones not named yet. */
export function PeoplePage() {
  const photosPath = usePhotosPath();
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
  const qc = useQueryClient();
  // Nobody here yet: is face recognition simply off?
  const nobody = !isLoading && named.length === 0 && unnamed.length === 0;
  const { data: settings } = useQuery({ queryKey: ["photos", "settings"], queryFn: photosApi.settings, enabled: nobody && kind === "person" });
  const [turningOn, setTurningOn] = useState(false);
  const turnOnFaces = async () => {
    setTurningOn(true);
    try {
      const next = await photosApi.saveSettings({ faces: true });
      qc.setQueryData(["photos", "settings"], next);
      void qc.invalidateQueries({ queryKey: ["people"] });
      toast.success("Face recognition is on. People will show up here as your photos are looked through.");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't turn that on."));
    } finally {
      setTurningOn(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
        <h1 className="mr-2 text-base font-semibold text-[var(--text)]">Faces</h1>
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
              className={cn(PILL, kind === k ? PILL_ON : PILL_OFF)}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </nav>
        <label className="ml-auto flex min-h-10 items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden
        </label>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {unnamed.length > 0 && (
          <section aria-label="Who is this?" className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-[var(--text)]">Who is this?</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3">
              {unnamed.map((r) => (
                <ReviewCard key={reviewKey(r)} entry={r} known={named} className="w-full" />
              ))}
            </div>
          </section>
        )}
        {isLoading ? (
          <ul aria-busy aria-label="Loading" className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-4">
            {Array.from({ length: 12 }, (_, i) => (
              <li key={i} className="flex flex-col items-center gap-2">
                <Skeleton className="h-24 w-24 rounded-full" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-3 w-14" />
              </li>
            ))}
          </ul>
        ) : nobody ? (
          kind === "pet" ? (
            <EmptyState
              icon={<PawPrint className="h-5 w-5" />}
              title="No pets yet"
              description="When a cat or dog turns up in your photos you'll be asked who it is. Name them once and the rest of their photos follow."
            />
          ) : settings && !settings.faces ? (
            <EmptyState
              icon={<ScanFace className="h-5 w-5" />}
              title="Turn on face recognition"
              description="Promptly can find the people in your photos, so you name someone once and see all their photos together. Your photos never leave your own server, and you can turn it off again in Photos settings."
              action={
                <Button variant="primary" loading={turningOn} onClick={() => void turnOnFaces()}>
                  Turn on face recognition
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<UserRound className="h-5 w-5" />}
              title="No one here yet"
              description={
                showHidden
                  ? "Nobody has been found in your photos yet. People show up here as your photos are looked through; it can take a while for a big library."
                  : "People show up here as your photos are looked through; it can take a while for a big library. Anyone you've hidden is under Show hidden."
              }
            />
          )
        ) : (
          <ul aria-label={kind === "person" ? "People" : "Pets"} className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-4">
            {named.map((p) => (
              <li key={p.id}>
                <Link to={photosPath(`/people/${p.id}`)} className="group flex flex-col items-center gap-1.5 text-center">
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
  const [active, setActive] = useState(0);
  // Everyone already named, searched as you type: names starting with what's
  // typed first, then ones containing it (the same species first for a pet).
  const typed = name.trim().toLowerCase();
  const exact = typed ? known.find((k) => k.name?.toLowerCase() === typed) : undefined;
  const matches = typed
    ? known
        .filter((k) => k.name?.toLowerCase().includes(typed))
        .sort(
          (x, y) =>
            Number(y.name!.toLowerCase().startsWith(typed)) - Number(x.name!.toLowerCase().startsWith(typed)) ||
            Number(y.species === entry.species) - Number(x.species === entry.species) ||
            x.name!.localeCompare(y.name!),
        )
        .slice(0, 6)
    : [];
  const rows = typed ? matches.length + (exact ? 0 : 1) : 0;
  const done = (label: string) => {
    void qc.invalidateQueries({ queryKey: ["people"] });
    toast.success(label);
  };

  const save = async (who: { person_id?: string; name?: string }, label: string) => {
    if (!chosen.length) return;
    // A name you already use is that person — never a second one.
    if (!who.person_id && who.name) {
      const same = known.find((k) => k.name?.toLowerCase() === who.name!.toLowerCase());
      if (same?.id) who = { person_id: same.id };
    }
    setBusy(true);
    try {
      if (entry.id && isPerson) {
        // A cluster: the unticked ones aren't this person; the ticked ones
        // are (confirmed by you), and the rest of the cluster — and their
        // look-alikes — follow from them.
        for (const s of entry.samples) if (left.has(s.id)) await peopleApi.notThem(s.id, entry.id);
        await peopleApi.nameMany(chosen.map((s) => s.id), who);
      } else if (entry.id) {
        for (const s of entry.samples) if (left.has(s.id)) await peopleApi.notThem(s.id, entry.id);
        const same = who.person_id;
        if (same) await peopleApi.merge(entry.id, same);
        else await peopleApi.update(entry.id, { name: who.name ?? null });
      } else {
        // Loose faces (or a species of animal): the unticked ones aren't a
        // suggested person, the ticked ones are who you said.
        if (entry.suggest) for (const s of entry.samples) if (left.has(s.id)) await peopleApi.notThem(s.id, entry.suggest.id);
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

  // "Is this Sarah?" — No: none of these are them, and they won't be asked about them again.
  const notSuggested = async () => {
    if (!entry.suggest) return;
    setBusy(true);
    try {
      for (const s of entry.samples) await peopleApi.notThem(s.id, entry.suggest.id);
      setLeft(new Set());
      done(`Got it — not ${entry.suggest.name ?? "them"}.`);
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

  const suggest = entry.suggest;
  const title = suggest
    ? `Is this ${suggest.name ?? "them"}?`
    : isPerson
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
          {suggest && (
            <p className="text-xs text-[var(--text-muted)]">
              {entry.photos.toLocaleString()} {entry.photos === 1 ? "photo" : "photos"} that look like them
            </p>
          )}
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

      {suggest && (
        <div className="flex items-center gap-2" role="group" aria-label={title}>
          {suggest.cover && <img src={suggest.cover} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />}
          <Button
            size="sm"
            variant="primary"
            className="h-9 flex-1"
            disabled={busy || !chosen.length}
            onClick={() => void save({ person_id: suggest.id }, suggest.name ?? "them")}
          >
            <Check className="h-4 w-4" /> Yes{chosen.length < entry.samples.length ? ` (${chosen.length})` : ""}
          </Button>
          <Button size="sm" variant="secondary" className="h-9 flex-1" disabled={busy} onClick={() => void notSuggested()}>
            <X className="h-4 w-4" /> No
          </Button>
        </div>
      )}

      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          // Enter takes the highlighted row: someone you've named, or "new".
          const pick = matches[active];
          if (pick?.id) void save({ person_id: pick.id }, pick.name!);
          else if (name.trim()) void save({ name: name.trim() }, name.trim());
        }}
      >
        <div className="flex items-center gap-1">
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && rows) {
                e.preventDefault();
                setActive((a) => (a + 1) % rows);
              } else if (e.key === "ArrowUp" && rows) {
                e.preventDefault();
                setActive((a) => (a - 1 + rows) % rows);
              } else if (e.key === "Escape" && name) {
                e.preventDefault();
                setName("");
              }
            }}
            placeholder={suggest ? "Someone else? Type a name…" : isPerson ? "Who is this? Type a name…" : `Name this ${entry.species ?? "pet"}…`}
            aria-label={isPerson ? "Who is this?" : `Name this ${entry.species ?? "pet"}`}
            role="combobox"
            aria-expanded={rows > 0}
            aria-autocomplete="list"
            className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs"
          />
          <Button size="sm" variant="secondary" type="submit" disabled={busy || !typed || !chosen.length} aria-label="Save name">
            <Check className="h-3.5 w-3.5" />
          </Button>
        </div>
        {rows > 0 && (
          <ul role="listbox" aria-label="People you've named" className="overflow-hidden rounded-md border border-[var(--border)]">
            {matches.map((k, i) => (
              <li key={k.id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  disabled={busy || !chosen.length}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => void save({ person_id: k.id! }, k.name!)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1 text-left text-xs text-[var(--text)] disabled:opacity-50",
                    i === active && "bg-[var(--hover)]",
                  )}
                >
                  {k.cover ? (
                    <img src={k.cover} alt="" className="h-6 w-6 rounded-full object-cover" />
                  ) : (
                    <span className="h-6 w-6 rounded-full bg-[var(--hover)]" />
                  )}
                  <span className="flex-1 truncate">{k.name}</span>
                  <span className="text-[var(--text-muted)]">{k.photos.toLocaleString()}</span>
                </button>
              </li>
            ))}
            {!exact && (
              <li role="option" aria-selected={active === matches.length}>
                <button
                  type="button"
                  disabled={busy || !chosen.length}
                  onMouseEnter={() => setActive(matches.length)}
                  onClick={() => void save({ name: name.trim() }, name.trim())}
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1 text-left text-xs text-[var(--text)] disabled:opacity-50",
                    active === matches.length && "bg-[var(--hover)]",
                  )}
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--hover)]">
                    <Plus className="h-3.5 w-3.5" />
                  </span>
                  <span className="flex-1 truncate">
                    New {isPerson ? "person" : (entry.species ?? "pet")} “{name.trim()}”
                  </span>
                </button>
              </li>
            )}
          </ul>
        )}
      </form>
    </article>
  );
}

/** One person or pet: their photos, and naming, hiding, "this is me",
 *  merging. */
export function PersonPage() {
  const photosPath = usePhotosPath();
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
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  usePopoverDismiss(menu, menuRef, closeMenu);
  const [merging, setMerging] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [view, setView] = useState<"photos" | "faces">("photos");
  const { data: others } = useQuery({ queryKey: ["people", kind, false], queryFn: () => peopleApi.list(kind), enabled: merging });
  // Their contact (when linked): the birthday shows by their name.
  const linked = useLinkedContact(kind === "person" ? person?.contact : null);
  const bday = birthdayLabel(linked.contact?.birthday);

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
  if (!person)
    return (
      <div className="flex h-full min-h-0 flex-col" aria-busy aria-label="Loading">
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <Skeleton className="h-14 w-14 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-1 p-4 sm:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="aspect-[4/3] w-full" />
          ))}
        </div>
      </div>
    );

  // "Same person as…": show both faces and ask first; Undo straight after.
  const mergeInto = async (o: Subject) => {
    if (!o.id || mergeBusy) return;
    const fromName = person.name ?? (kind === "pet" ? "This pet" : "This person");
    // Undo puts their faces back under their old name, so it needs one.
    const undoable = kind === "person" && !!person.name && person.name.trim().toLowerCase() !== (o.name ?? "").trim().toLowerCase();
    const ok = await confirm({
      title: kind === "pet" ? `Is this the same pet as ${o.name}?` : `Is this the same person as ${o.name}?`,
      message: (
        <span className="flex flex-col gap-3">
          <span className="flex items-center justify-center gap-4">
            <MergeFace subject={person} name={fromName} />
            <ArrowRight className="h-5 w-5 shrink-0 text-[var(--text-muted)]" aria-hidden />
            <MergeFace subject={o} name={o.name ?? ""} />
          </span>
          <span>
            All {person.photos.toLocaleString()} {person.photos === 1 ? "photo" : "photos"} here will be filed under {o.name}
            {person.name ? `, and “${person.name}” goes away` : ""}. {undoable ? "You can undo this straight after." : "This can't be undone in one tap, so check the faces match."}
          </span>
        </span>
      ),
      confirmLabel: "Merge",
    });
    if (!ok) return;
    setMergeBusy(true);
    try {
      const before = undoable ? await facesOf(personId).catch(() => null) : null;
      await peopleApi.merge(personId, o.id);
      refresh();
      setMerging(false);
      const keep = { name: person.name!, relationship: person.relationship ?? null, me: person.me, hidden: person.hidden, memories: person.memories, contact: person.contact ?? null };
      const into = o.id;
      toast.success(
        `Merged into ${o.name}.`,
        before?.length
          ? {
              action: {
                label: "Undo",
                onClick: () => {
                  void (async () => {
                    try {
                      const back = await peopleApi.split(into, before, { name: keep.name });
                      // What they had besides photos: best effort, the photos matter most.
                      if (keep.relationship) await peopleApi.setRelationship(back, keep.relationship).catch(() => {});
                      const patch: Parameters<typeof peopleApi.update>[1] = {};
                      if (keep.me) patch.me = true;
                      if (keep.hidden) patch.hidden = true;
                      if (keep.memories === false) patch.memories = false;
                      if (keep.contact) patch.contact = keep.contact;
                      if (Object.keys(patch).length) await peopleApi.update(back, patch).catch(() => {});
                      refresh();
                      toast.success(`${keep.name} is back.`);
                      navigate(photosPath(`/people/${back}`), { replace: true });
                    } catch (e) {
                      toast.error(apiErrorMessage(e, "Couldn't undo that. Open Faces on their page to move the photos back."));
                    }
                  })();
                },
              },
            }
          : undefined,
      );
      navigate(photosPath(`/people/${into}`), { replace: true });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't merge them."));
    } finally {
      setMergeBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <Link to={photosPath(`/people${kind === "pet" ? "?kind=pet" : ""}`)} aria-label="Back to Faces" title="Back to Faces" className={cn(HEAD_BTN, "-ml-2")}>
          <ArrowLeft className="h-5 w-5" />
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
            {person.hidden ? " · hidden from Faces" : ""}
            {bday ? ` · ${bday.short}` : ""}
          </p>
          {kind === "person" && !person.me && <Relationship id={personId} value={person.relationship ?? null} onSaved={refresh} />}
          {kind === "person" && (
            <Link
              to={personPath({ kind: "p", personId })}
              className="mt-1 inline-flex h-7 items-center gap-1 text-xs font-medium text-[var(--accent-text,var(--accent))] hover:underline"
            >
              <UserRound className="h-3 w-3" /> Open person page
            </Link>
          )}
        </div>
        <div className="relative" ref={menuRef}>
          <button type="button" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} className={cn(HEAD_BTN, "-mr-2")}>
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {menu && (
            <div role="menu" className="absolute right-0 z-20 mt-1 w-60 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 text-sm shadow-lg [&>button]:min-h-10">
              {kind === "person" && (
                <button type="button" role="menuitem" className="w-full rounded px-2 py-1.5 text-left hover:bg-[var(--hover)]"
                  onClick={() => { setMenu(false); void update({ me: !person.me }, person.me ? "Not you, then." : "That's you."); }}>
                  {person.me ? "This isn't me" : "This is me"}
                </button>
              )}
              <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--hover)]"
                onClick={() => { setMenu(false); void update({ hidden: !person.hidden }, person.hidden ? "Shown in Faces again." : "Hidden from Faces."); }}>
                <EyeOff className="h-3.5 w-3.5" /> {person.hidden ? "Show in Faces" : "Hide from Faces"}
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
      {kind === "person" && <PersonContact personId={personId} person={person} />}
      {merging && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2 text-sm" role="group" aria-label="Who are they the same as?">
          <span className="text-[var(--text-muted)]">Who are they the same as?</span>
          {others === undefined ? (
            <Skeleton className="h-8 w-40 rounded-full" />
          ) : (
            others
              .filter((o) => o.id !== personId && o.name)
              .map((o) => (
                <button
                  key={o.id}
                  type="button"
                  disabled={mergeBusy}
                  onClick={() => void mergeInto(o)}
                  className="inline-flex h-10 items-center gap-1.5 rounded-full border border-[var(--border)] pl-1 pr-3 text-xs hover:bg-[var(--hover)] disabled:opacity-50 md:h-8"
                >
                  {o.cover ? <img src={o.cover} alt="" className="h-6 w-6 rounded-full object-cover" /> : <span className="h-6 w-6 rounded-full bg-[var(--hover)]" />}
                  {o.name}
                </button>
              ))
          )}
          {others !== undefined && others.filter((o) => o.id !== personId && o.name).length === 0 && (
            <span className="text-xs text-[var(--text-muted)]">Nobody else has a name yet.</span>
          )}
          <button type="button" className="inline-flex h-10 items-center rounded-lg px-2 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-8" onClick={() => setMerging(false)}>
            Cancel
          </button>
        </div>
      )}
      <nav aria-label="Photos or faces" className="flex gap-1 border-b border-[var(--border)] px-4 py-1.5">
        {(["photos", "faces"] as const).map((v) => (
          <button key={v} type="button" aria-current={view === v ? "page" : undefined} onClick={() => setView(v)}
            className={cn(PILL, view === v ? PILL_ON : PILL_OFF)}>
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

/** One side of "same person?": their face, big enough to compare. */
function MergeFace({ subject, name }: { subject: { cover: string | null; name: string | null }; name: string }) {
  return (
    <span className="flex w-24 flex-col items-center gap-1.5 text-center">
      {subject.cover ? (
        <img src={subject.cover} alt="" className="h-20 w-20 rounded-full object-cover" />
      ) : (
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--hover)] text-[var(--text-muted)]">
          <UserRound className="h-7 w-7" />
        </span>
      )}
      <span className="w-full truncate text-xs font-medium text-[var(--text)]">{name}</span>
    </span>
  );
}

/** Every face filed under someone (for undoing a merge). Null when there
 *  are more than can be moved back in one go. */
async function facesOf(id: string): Promise<string[] | null> {
  const LIMIT = 2000;
  const ids: string[] = [];
  for (;;) {
    const page = await peopleApi.faces(id, ids.length);
    for (const f of page.faces) ids.push(f.id);
    if (!page.more || page.faces.length === 0) return ids;
    if (ids.length >= LIMIT) return null;
  }
}

const RELATIONS = ["my wife", "my husband", "my partner", "my son", "my daughter", "Mum", "Dad", "my brother", "my sister",
  "Grandma", "Grandpa", "a friend", "a colleague"];

/** Who they are to you — your words; nobody else sees them. */
function Relationship({ id, value, onSaved }: { id: string; value: string | null; onSaved: () => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);
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
