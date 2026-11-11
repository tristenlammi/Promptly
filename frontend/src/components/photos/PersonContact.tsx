import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cake, Contact as ContactIcon, ExternalLink, Link2, Mail, Phone, Search, Unlink, UserPlus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { peopleApi, type ContactRef, type Subject } from "@/api/people";
import { Button } from "@/components/shared/Button";
import { itemsApi } from "@/items/api";
import { displayName, fold, homeCountry, sortContacts, telHref, workLine } from "@/items/kinds/contacts/model";
import { shrinkPhoto } from "@/items/kinds/contacts/photo";
import { birthdayLabel, contactLinksKey, contactNameScore, contactPath, useContactLinks } from "@/items/kinds/contacts/photosLink";
import { ContactAvatar } from "@/items/kinds/contacts/shared";
import type { Contact, ContactsData } from "@/items/kinds/contacts/types";
import { Sheet } from "@/items/ui";
import "@/items/ui/items.css";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";
import { SkeletonRows } from "@/components/shared/Skeleton";

/*
 * A Photos person ↔ their contact. Linked: a compact contact card under the
 * person's header (birthday, a tap to call or email, Open in Contacts).
 * Not linked: "Link to a contact" — pick one from your Contacts, or add them
 * as a new contact with their face as its photo. The link is yours alone
 * (it's on your Photos person); nothing is shared with anyone.
 */

/** Your Contacts app: added or not, and its file (null until it's first opened). */
function useContactsApp(enabled = true) {
  return useQuery({
    queryKey: ["photos-contacts-app"],
    queryFn: async () => {
      const apps = await itemsApi.launcher();
      const app = apps.find((a) => a.kind === "contacts");
      return { installed: !!app, fileId: app?.latest ?? null };
    },
    enabled,
    staleTime: 60_000,
  });
}

function useContactsDoc(fileId: string | null | undefined) {
  return useQuery({
    queryKey: ["photos-contacts-doc", fileId],
    queryFn: () => itemsApi.get<ContactsData>(fileId!),
    enabled: !!fileId,
    staleTime: 30_000,
    retry: false,
  });
}

/** The contact a person is linked to: ``missing`` when the link points at a
 *  contact (or a file) that's gone. */
export function useLinkedContact(ref: ContactRef | null | undefined) {
  const doc = useContactsDoc(ref?.file_id);
  const contact = ref && doc.data ? (doc.data.data.contacts ?? []).find((c) => c.id === ref.contact_id) ?? null : null;
  return {
    contact,
    data: doc.data?.data ?? null,
    loading: !!ref && doc.isLoading,
    missing: !!ref && (doc.isError || (!!doc.data && !contact)),
  };
}

/** The contact section of a person's page (people only, not pets). */
export function PersonContact({ personId, person }: { personId: string; person: Subject }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ref = person.contact ?? null;
  const linked = useLinkedContact(ref);
  const userSettings = useAuthStore((s) => s.user?.settings) as Record<string, unknown> | undefined;
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const unlink = async () => {
    setBusy(true);
    try {
      await peopleApi.setContact(personId, null);
      void qc.invalidateQueries({ queryKey: ["people"] });
      if (ref) void qc.invalidateQueries({ queryKey: contactLinksKey(ref.file_id) });
      toast.success("Unlinked from the contact.");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't unlink them."));
    } finally {
      setBusy(false);
    }
  };

  if (!ref) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border)] px-4 py-2.5">
        <p className="min-w-0 flex-1 text-xs text-[var(--text-muted)]">Link {person.name ?? "them"} to a contact for their birthday, number and email here.</p>
        <Button size="sm" variant="secondary" leftIcon={<Link2 className="h-3.5 w-3.5" />} onClick={() => setPicking(true)}>
          Link to a contact
        </Button>
        {picking && <LinkContactSheet personId={personId} person={person} onClose={() => setPicking(false)} />}
      </div>
    );
  }

  if (linked.loading) {
    return (
      <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3" aria-busy="true">
        <span className="h-10 w-10 animate-pulse rounded-full bg-[var(--hover)]" />
        <span className="h-3 w-40 animate-pulse rounded bg-[var(--hover)]" />
      </div>
    );
  }

  const c = linked.contact;
  if (!c) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border)] px-4 py-2.5">
        <p className="min-w-0 flex-1 text-xs text-[var(--text-muted)]">The contact they were linked to isn't in your Contacts any more.</p>
        <Button size="sm" variant="ghost" leftIcon={<Unlink className="h-3.5 w-3.5" />} onClick={() => void unlink()} loading={busy}>
          Unlink
        </Button>
      </div>
    );
  }

  const name = displayName(c, linked.data?.settings?.name_order);
  const bday = birthdayLabel(c.birthday);
  const phone = c.phones?.[0]?.value;
  const email = c.emails?.[0]?.value;
  const sub = workLine(c);
  const country = homeCountry(linked.data?.settings, userSettings);
  const detail = "flex min-h-[32px] items-center gap-1.5 sm:min-h-0";

  return (
    <section aria-label="Their contact" className="border-b border-[var(--border)] px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <ContactAvatar contact={c} size={40} linked={false} />
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-sm font-medium text-[var(--text)]">{name}</span>
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-muted)]">
                <ContactIcon className="h-3 w-3" aria-hidden /> Contact
              </span>
            </p>
            {sub && <p className="truncate text-xs text-[var(--text-muted)]">{sub}</p>}
            {(bday || phone || email) && (
              <ul className="mt-1 flex flex-wrap gap-x-4 text-xs">
                {bday && (
                  <li className={cn(detail, "text-[var(--text)]")}>
                    <Cake className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-hidden /> {bday.line}
                  </li>
                )}
                {phone && (
                  <li>
                    <a href={telHref(phone, country)} className={cn(detail, "text-[var(--accent-text)] hover:underline")}>
                      <Phone className="h-3.5 w-3.5" aria-hidden /> {phone}
                    </a>
                  </li>
                )}
                {email && (
                  <li className="min-w-0 max-w-full">
                    <a href={`mailto:${email}`} className={cn(detail, "min-w-0 text-[var(--accent-text)] hover:underline")}>
                      <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden /> <span className="truncate">{email}</span>
                    </a>
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 pl-[52px] sm:pl-0">
          <Button size="sm" variant="secondary" leftIcon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => navigate(contactPath(ref.file_id, ref.contact_id))}>
            Open in Contacts
          </Button>
          <Button size="sm" variant="ghost" leftIcon={<Unlink className="h-3.5 w-3.5" />} onClick={() => void unlink()} loading={busy}>
            Unlink
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Suggested under this name score. */
const LIKELY = 0.5;

/** "Who are they in your Contacts?": your contacts, the likeliest by name
 *  first, or a new contact made from this person (their face as its photo). */
function LinkContactSheet({ personId, person, onClose }: { personId: string; person: Subject; onClose: () => void }) {
  const qc = useQueryClient();
  const app = useContactsApp();
  const fileId = app.data?.fileId ?? null;
  const doc = useContactsDoc(fileId);
  const links = useContactLinks(fileId);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"link" | "add" | "install" | null>(null);

  const data = doc.data?.data;
  const groups = useMemo(() => {
    const contacts = data?.contacts ?? [];
    const q = fold(query);
    const order = data?.settings?.name_order;
    const pool = q ? contacts.filter((c) => fold([displayName(c, order), c.nickname, c.company].join(" ")).includes(q)) : contacts;
    const suggested = q
      ? []
      : contacts
          .map((c) => ({ c, score: contactNameScore(c, person.name) }))
          .filter((x) => x.score >= LIKELY)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((x) => x.c);
    const shown = new Set(suggested.map((c) => c.id));
    const rest = sortContacts(pool.filter((c) => !shown.has(c.id)), data?.settings?.sort_by ?? "first");
    return [
      { label: "Suggested", list: suggested },
      { label: q ? "Matches" : suggested.length ? "Everyone else" : "Your contacts", list: rest },
    ].filter((g) => g.list.length);
  }, [data, query, person.name]);

  // A new contact needs a name: theirs, or what's typed when they have none.
  const newName = (person.name ?? "").trim() || query.trim();

  const done = (fid: string, label: string) => {
    void qc.invalidateQueries({ queryKey: ["people"] });
    void qc.invalidateQueries({ queryKey: contactLinksKey(fid) });
    void qc.invalidateQueries({ queryKey: ["photos-contacts-doc", fid] });
    toast.success(label);
    onClose();
  };

  const link = async (c: Contact) => {
    if (!fileId) return;
    setBusy("link");
    try {
      const contactName = displayName(c);
      // An unnamed person takes the contact's name as they're linked.
      await peopleApi.update(personId, { contact: { file_id: fileId, contact_id: c.id }, ...(person.name ? {} : { name: contactName }) });
      done(fileId, `Linked to ${contactName}.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't link them."));
      setBusy(null);
    }
  };

  const addNew = async () => {
    if (!newName) return;
    setBusy("add");
    try {
      // No file yet: opening the app makes it.
      const fid = fileId ?? (await itemsApi.openApp("contacts")).file_id;
      // Their face, shrunk on this device like any contact photo.
      const photo = person.cover ? await shrinkPhoto(person.cover) : null;
      const add = (withPhoto: boolean) =>
        itemsApi.action<ContactsData>(fid, "add_contacts", { contacts: [{ full_name: newName, ...(withPhoto && photo ? { photo } : {}) }] });
      let res;
      try {
        res = await add(true);
      } catch (e) {
        if (!photo) throw e;
        res = await add(false); // e.g. no room left for photos in the file
      }
      const added = (res.result as { added?: { id: string }[] } | null)?.added?.[0]?.id;
      if (!added) throw new Error("The contact wasn't added.");
      await peopleApi.update(personId, { contact: { file_id: fid, contact_id: added }, ...(person.name ? {} : { name: newName }) });
      void qc.invalidateQueries({ queryKey: ["photos-contacts-app"] });
      done(fid, `Added ${newName} to Contacts.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't add them to Contacts."));
      setBusy(null);
    }
  };

  const install = async () => {
    setBusy("install");
    try {
      await itemsApi.add("contacts");
      void qc.invalidateQueries({ queryKey: ["apps-launcher"] });
      await qc.invalidateQueries({ queryKey: ["photos-contacts-app"] });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't add Contacts."));
    } finally {
      setBusy(null);
    }
  };

  const title = person.name ? `Who is ${person.name} in Contacts?` : "Link to a contact";

  return (
    <Sheet open onClose={onClose} title={title}>
      {app.isLoading ? (
        <SkeletonRows count={4} className="py-2" label="Loading" />
      ) : app.isError ? (
        <p className="py-8 text-center text-sm text-[var(--text-muted)]">Couldn't reach your apps. Try again in a moment.</p>
      ) : !app.data?.installed ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-text)]">
            <ContactIcon className="h-6 w-6" />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-[var(--text)]">Contacts isn't in your apps yet</p>
            <p className="max-w-sm text-sm text-[var(--text-muted)]">
              Add the Contacts app to keep numbers, emails and birthdays with the people in your photos. It's private to you.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="primary" leftIcon={<UserPlus className="h-3.5 w-3.5" />} loading={busy === "install"} onClick={() => void install()}>
              Add Contacts
            </Button>
            <Link to="/apps/store" className="inline-flex h-8 items-center rounded-input px-3 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]">
              Browse the App Store
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="sticky top-0 z-10 -mx-5 bg-[var(--bg)] px-5 pb-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={person.name ? "Search your contacts" : "Search, or type their name"}
                aria-label="Search your contacts"
                className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-9 text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] md:h-10 md:text-sm"
              />
              {query && (
                <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-4 pt-1">
            {/* A new contact from this person — always on offer. */}
            <button
              type="button"
              disabled={!newName || busy !== null}
              onClick={() => void addNew()}
              className="flex min-h-[56px] w-full items-center gap-3 rounded-2xl border border-dashed border-[var(--border)] px-3 py-2 text-left transition hover:bg-[var(--hover)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <span className="relative shrink-0">
                {person.cover ? (
                  <img src={person.cover} alt="" aria-hidden className="h-10 w-10 rounded-full object-cover" />
                ) : (
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--hover)] text-[var(--text-muted)]">
                    <UserPlus className="h-5 w-5" />
                  </span>
                )}
                {person.cover && (
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white ring-2 ring-[var(--bg)]">
                    <UserPlus className="h-3 w-3" />
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--text)]">
                  {busy === "add" ? "Adding…" : newName ? `Add ${newName} to Contacts` : "Add to Contacts"}
                </span>
                <span className="block truncate text-xs text-[var(--text-muted)]">
                  {newName ? "A new contact, with this face as its photo" : "Type their name above first"}
                </span>
              </span>
            </button>

            {fileId && doc.isLoading ? (
              <p className="py-4 text-center text-sm text-[var(--text-muted)]">Loading your contacts…</p>
            ) : fileId && doc.isError ? (
              <p className="py-4 text-center text-sm text-[var(--text-muted)]">Couldn't load your contacts.</p>
            ) : groups.length === 0 ? (
              (data?.contacts?.length ?? 0) > 0 && (
                <p className="py-4 text-center text-sm text-[var(--text-muted)]" aria-live="polite">
                  No contact matches “{query}”.
                </p>
              )
            ) : (
              groups.map((g) => (
                <section key={g.label} aria-label={g.label}>
                  <h3 className="mb-1.5 px-1 text-xs font-semibold text-[var(--accent-text)]">{g.label}</h3>
                  <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                    {g.list.slice(0, 300).map((c) => {
                      const other = links.data?.[c.id];
                      const line = [workLine(c) || c.emails?.[0]?.value || c.phones?.[0]?.value, other && other.person_id !== personId ? `in Photos as ${other.name ?? "someone else"}` : ""]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void link(c)}
                            className="flex min-h-[56px] w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-[var(--hover)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                          >
                            <ContactAvatar contact={c} size={40} linked={false} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-[var(--text)]">{displayName(c, data?.settings?.name_order)}</span>
                              {line && <span className="block truncate text-xs text-[var(--text-muted)]">{line}</span>}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {g.list.length > 300 && <p className="mt-1.5 px-1 text-xs text-[var(--text-muted)]">Search to find more.</p>}
                </section>
              ))
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
