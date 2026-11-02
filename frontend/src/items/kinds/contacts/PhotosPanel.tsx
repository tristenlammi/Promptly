import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Images, Link2, Search, Unlink, UserRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { peopleApi, type Subject } from "@/api/people";
import { ItemButton, Sheet } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { fold } from "./model";
import { contactLinksKey, contactNameScore, photosPersonPath, useLinkedPerson } from "./photosLink";
import { Panel, type Handle } from "./shared";
import type { Contact } from "./types";

/* The person page's "Photos" section: their face and all their photos when
 * they're linked to someone in your Photos, or "Link to someone in Photos".
 * Links are yours alone (they live on your Photos people), so this works on
 * a Contacts file you can only read too. */

/** Your named Photos people (the same list and cache as Photos' People page). */
function usePhotosPeople() {
  return useQuery({
    queryKey: ["people", "person", false],
    queryFn: () => peopleApi.list("person"),
    staleTime: 60_000,
    retry: false,
  });
}

/** A good-enough name match to offer without opening the picker. */
const SURE = 0.8;
/** Shown under "Suggested" in the picker. */
const LIKELY = 0.5;

export function PhotosPanel({ item, c, name, first }: { item: Handle; c: Contact; name: string; first: string }) {
  const link = useLinkedPerson(c.id);
  const people = usePhotosPeople();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const all = people.data ?? [];
  const linkedPerson = link ? all.find((p) => p.id === link.person_id) : undefined;
  // One sure match nobody's linked yet: ask about it right here.
  const guess = useMemo(() => {
    if (link) return null;
    let best: { p: Subject; score: number } | null = null;
    for (const p of all) {
      if (!p.id || !p.name || p.contact) continue;
      const score = contactNameScore(c, p.name);
      if (score >= SURE && (!best || score > best.score)) best = { p, score };
    }
    return best?.p ?? null;
  }, [all, c, link]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: contactLinksKey(item.fileId) });
    void qc.invalidateQueries({ queryKey: ["people"] });
  };

  const linkTo = async (p: Subject) => {
    if (!p.id) return;
    setBusy(true);
    try {
      // An unnamed face group takes the contact's name as it's linked.
      await peopleApi.update(p.id, { contact: { file_id: item.fileId, contact_id: c.id }, ...(p.name ? {} : { name }) });
      refresh();
      setPicking(false);
      toast.success(p.name ? `Linked to ${p.name} in Photos.` : `Linked — named ${name} in Photos.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't link them."));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    if (!link) return;
    setBusy(true);
    try {
      await peopleApi.setContact(link.person_id, null);
      refresh();
      toast.success("Unlinked from Photos.");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't unlink them."));
    } finally {
      setBusy(false);
    }
  };

  // No Photos people (or Photos isn't there): nothing to say.
  if (!link && !all.some((p) => p.id)) return null;

  return (
    <Panel title="Photos" icon={Images}>
      {link ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Face src={link.face} size={56} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-[var(--text)]">{link.name || name}</p>
              <p className="text-xs text-[var(--text-muted)]">
                {linkedPerson ? `${linkedPerson.photos.toLocaleString()} ${linkedPerson.photos === 1 ? "photo" : "photos"}` : "In your Photos"}
                {!c.photo && " · their face is the photo here"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <ItemButton size="sm" variant="primary" icon={<Images className="h-3.5 w-3.5" />} onClick={() => navigate(photosPersonPath(link.person_id))}>
              See all photos of {first}
            </ItemButton>
            <ItemButton size="sm" variant="ghost" icon={<Unlink className="h-3.5 w-3.5" />} onClick={() => void unlink()} disabled={busy}>
              Unlink
            </ItemButton>
          </div>
        </div>
      ) : guess ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Face src={guess.cover} size={48} />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-[var(--text)]">
                Is this <span className="font-medium">{guess.name}</span> in your Photos?
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                {guess.photos.toLocaleString()} {guess.photos === 1 ? "photo" : "photos"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <ItemButton size="sm" variant="primary" icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => void linkTo(guess)} disabled={busy}>
              Yes, link them
            </ItemButton>
            <ItemButton size="sm" variant="ghost" onClick={() => setPicking(true)}>
              Someone else…
            </ItemButton>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-[var(--text-muted)]">Link {first} to someone in your Photos to see their face here and all their photos in a tap.</p>
          <ItemButton size="sm" icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => setPicking(true)}>
            Link to someone in Photos
          </ItemButton>
        </div>
      )}
      <PersonPicker open={picking} onClose={() => setPicking(false)} c={c} name={name} people={all} busy={busy} onPick={(p) => void linkTo(p)} />
    </Panel>
  );
}

/** A round face crop (or a placeholder). */
function Face({ src, size }: { src: string | null | undefined; size: number }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className="shrink-0 rounded-full bg-[var(--surface-2)] object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span aria-hidden className="flex shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]" style={{ width: size, height: size }}>
      <UserRound className="h-1/2 w-1/2" />
    </span>
  );
}

/** "Which one is them?": your Photos people, the likeliest by name first,
 *  then everyone named, then faces not named yet. */
function PersonPicker({
  open,
  onClose,
  c,
  name,
  people,
  busy,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  c: Contact;
  name: string;
  people: Subject[];
  busy: boolean;
  onPick: (p: Subject) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = fold(query);
    const pool = people.filter((p) => p.id && (!q || fold(p.name ?? "").includes(q)));
    const scored = pool.filter((p) => p.name).map((p) => ({ p, score: contactNameScore(c, p.name) }));
    const suggested = q ? [] : scored.filter((x) => x.score >= LIKELY).sort((a, b) => b.score - a.score).map((x) => x.p);
    const shown = new Set(suggested.map((p) => p.id));
    const named = scored.map((x) => x.p).filter((p) => !shown.has(p.id)).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    const unnamed = q ? [] : pool.filter((p) => !p.name);
    return [
      { label: "Suggested", list: suggested },
      { label: suggested.length ? "Everyone else" : "Your people", list: named },
      { label: "Not named yet", list: unnamed },
    ].filter((g) => g.list.length);
  }, [people, query, c]);

  return (
    <Sheet open={open} onClose={onClose} title={`Who is ${name} in Photos?`}>
      <div className="sticky top-0 z-10 -mx-5 bg-[var(--bg)] px-5 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your people"
            aria-label="Search your Photos people"
            className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-9 text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--item-accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--item-accent)_25%,transparent)] md:h-10 md:text-sm"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-muted)]" aria-live="polite">
          {query ? `No one in your Photos matches “${query}”.` : "No people in your Photos yet."}
        </p>
      ) : (
        <div className="flex flex-col gap-4 pt-1">
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <h3 className="mb-1.5 px-1 text-xs font-semibold text-[var(--item-accent)]">{g.label}</h3>
              <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                {g.list.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onPick(p)}
                      className={cn(
                        "flex min-h-[56px] w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-[var(--hover)] disabled:opacity-60",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]",
                      )}
                    >
                      <Face src={p.cover} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate text-sm font-medium", p.name ? "text-[var(--text)]" : "italic text-[var(--text-muted)]")}>
                          {p.name ?? "Not named yet"}
                          {p.me && <span className="ml-1 text-xs font-normal text-[var(--text-muted)]">(you)</span>}
                        </span>
                        <span className="block truncate text-xs text-[var(--text-muted)]">
                          {p.photos.toLocaleString()} {p.photos === 1 ? "photo" : "photos"}
                          {p.relationship ? ` · ${p.relationship}` : ""}
                          {p.contact ? " · linked to another contact" : ""}
                          {!p.name ? ` · will be named ${name}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Sheet>
  );
}
