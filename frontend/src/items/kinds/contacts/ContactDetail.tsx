import {
  AlarmClock,
  ArrowLeft,
  Cake,
  Check,
  ChevronDown,
  ChevronLeft,
  Download,
  Gift,
  Globe,
  Handshake,
  History,
  Lightbulb,
  Link2,
  Mail,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Phone,
  Plus,
  Sparkles,
  Star,
  StickyNote,
  Trash2,
  UserRound,
  Users,
  Video,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { TagChips } from "@/components/tags/TagPicker";
import { LinkedSection } from "@/components/links/LinkedSection";
import { peopleHubApi, personPath } from "@/api/peopleHub";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { toast } from "@/store/toastStore";
import { Chip, Field, ItemButton, Select, Sheet, TextArea, TextInput, todayISO, uid } from "@/items/ui";
import { calls } from "@/rtc/call/actions";
import { cn } from "@/utils/cn";

import { ContactForm } from "./ContactForm";
import { LogSheet } from "./LogSheet";
import { PhotosPanel } from "./PhotosPanel";
import {
  CADENCES,
  addressLines,
  ageOf,
  agoLabel,
  buildIndex,
  daysFrom,
  displayName,
  dueOn,
  fmtDate,
  groupName,
  inDaysLabel,
  lastContacted,
  linkBothWays,
  mapsHref,
  matches,
  nextOccurrence,
  parseDateInput,
  removeContacts,
  smsHref,
  telHref,
  unlinkRelationship,
  webHref,
  workLine,
  yearsOn,
} from "./model";
import { ContactAvatar, INTERACTION_META, Panel, REL_LABELS, downloadText, editContact, safeFilename, overdueLabel, useHomeCountry, useWidth, type Handle } from "./shared";
import { REL_TYPES, type Contact, type Note, type RelType } from "./types";
import { toVCards } from "./vcard";

/* One person: reach them in a tap, keep in touch, remember what matters. */

export function ContactDetail({
  item,
  contactId,
  isPhone,
  ask,
  onBack,
  onOpen,
  onDeleted,
}: {
  item: Handle;
  contactId: string;
  isPhone: boolean;
  ask: (prompt: string) => void;
  onBack?: () => void;
  onOpen: (id: string) => void;
  onDeleted?: () => void;
}) {
  const c = item.data.contacts.find((x) => x.id === contactId);
  const cc = useHomeCountry(item);
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  usePopoverDismiss(menu, menuRef, () => setMenu(false));
  // Lay out by the room this pane actually has (list + AI panel share the screen).
  const width = useWidth(top, !!c);
  const mode: "narrow" | "medium" | "wide" = isPhone || (width > 0 && width < 560) ? "narrow" : width >= 760 ? "wide" : "medium";
  const narrow = mode === "narrow";

  // A different person: start at the top.
  useEffect(() => {
    top.current?.scrollIntoView({ block: "start" });
  }, [contactId]);

  if (!c) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--text-muted)]">
        {onBack ? (
          <ItemButton variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={onBack}>
            This contact is gone — back to Contacts
          </ItemButton>
        ) : (
          "Pick someone from the list."
        )}
      </div>
    );
  }

  const name = displayName(c, item.data.settings.name_order);
  const first = c.nickname || c.first || name;
  // Picked on the contact, or matched from their email.
  const { data: account } = useQuery({
    queryKey: ["people-hub", "contact", item.fileId, c.id, c.promptly_user_id, c.emails.map((e) => e.value).join()],
    queryFn: () => peopleHubApi.get({ kind: "c", fileId: item.fileId, contactId: c.id }),
    staleTime: 60_000,
    retry: false,
  });
  const can = item.canEdit;
  const today = todayISO();
  const bdayNext = c.birthday ? nextOccurrence(c.birthday, today) : null;
  const bdayIn = bdayNext !== null ? daysFrom(today, bdayNext) : null;
  const turns = c.birthday && bdayNext ? yearsOn(c.birthday, bdayNext) : null;
  const phone = c.phones[0]?.value;
  const email = c.emails[0]?.value;
  const sub = [c.pronouns, workLine(c)].filter(Boolean).join(" · ");
  const birthdayAsk = () => ask(`Draft a thoughtful birthday message for ${name} (contact id ${c.id}) — their birthday is ${fmtDate(bdayNext, { year: false })}.`);
  const setFavorite = () => {
    const target = !c.favorite; // what they saw, flipped
    editContact(item, c.id, (x) => {
      x.favorite = target;
    });
  };

  const moreMenu = (
    <div className="relative flex shrink-0 items-center" ref={menuRef}>
      <button
        type="button"
        aria-label="More for this contact"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((m) => !m)}
        className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]"
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
      {menu && (
        <div role="menu" className="absolute right-0 top-12 z-30 w-52 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)]">
          {can && <MenuItem icon={Pencil} label="Edit" onClick={() => { setEditing(true); setMenu(false); }} />}
          {can && (
            <MenuItem
              icon={Star}
              label={c.favorite ? "Remove from favourites" : "Add to favourites"}
              onClick={() => {
                setFavorite();
                setMenu(false);
              }}
            />
          )}
          <MenuItem
            icon={Download}
            label="Export vCard"
            onClick={() => {
              const byId = new Map(item.data.contacts.map((x) => [x.id, x]));
              downloadText(`${safeFilename(name)}.vcf`, toVCards([c], item.data.groups, "3.0", byId), "text/vcard");
              setMenu(false);
            }}
          />
          {can && <MenuItem icon={Trash2} label="Delete" danger onClick={() => { setConfirmDelete(true); setMenu(false); }} />}
        </div>
      )}
    </div>
  );

  const favButton = can && (
    <button
      type="button"
      aria-label={c.favorite ? "Remove from favourites" : "Add to favourites"}
      aria-pressed={c.favorite}
      onClick={setFavorite}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]"
    >
      <Star className={cn("h-5 w-5", c.favorite && "fill-[var(--item-accent)] text-[var(--item-accent)]")} />
    </button>
  );

  return (
    <div ref={top} className={cn("mx-auto flex w-full max-w-5xl scroll-mt-4 flex-col gap-4 pb-6", narrow ? "px-4" : "px-6", onBack ? "pt-0" : "pt-5")}>
      {/* Phone: an iOS-style bar — back to the list on the left, favourite / edit / more on the right. */}
      {onBack && (
        <div className="sticky top-0 z-20 -mx-4 flex h-12 items-center gap-0.5 bg-[var(--bg)] px-1">
          <button
            type="button"
            onClick={onBack}
            className="flex h-11 items-center gap-0.5 rounded-xl pl-1 pr-3 text-[15px] font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]"
          >
            <ChevronLeft className="h-6 w-6" aria-hidden />
            Contacts
          </button>
          <span className="flex-1" />
          {favButton}
          {can && (
            <button type="button" onClick={() => setEditing(true)} className="flex h-11 items-center rounded-xl px-3 text-[15px] font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]">
              Edit
            </button>
          )}
          {moreMenu}
        </div>
      )}

      {/* Hero */}
      <div className="relative flex items-start gap-3">
        <div className={cn("flex min-w-0 flex-1", narrow ? "flex-col items-center gap-2 text-center" : "flex-row items-center gap-5 text-left")}>
          <ContactAvatar contact={c} size={narrow ? 96 : 80} />
          <div className="min-w-0">
            <h2 className={cn("break-words font-semibold tracking-tight text-[var(--text)]", narrow ? "text-2xl" : "text-[26px] leading-tight")}>
              {[c.prefix, name].filter(Boolean).join(" ")}
              {c.favorite && !can && <Star className="ml-1.5 inline h-5 w-5 -translate-y-0.5 fill-[var(--item-accent)] text-[var(--item-accent)]" aria-label="Favourite" />}
            </h2>
            {c.nickname && c.nickname !== name && <p className="text-sm text-[var(--text-muted)]">“{c.nickname}”</p>}
            {sub && <p className="mt-0.5 text-sm text-[var(--text-muted)]">{sub}</p>}
            {account?.user && <p className="mt-0.5 text-sm text-[var(--item-accent)]">@{account.user.username} on Promptly</p>}
            <Link
              to={personPath({ kind: "c", fileId: item.fileId, contactId: c.id })}
              className="mt-1 inline-flex h-8 items-center gap-1 rounded-lg text-sm font-medium text-[var(--item-accent)] hover:underline"
            >
              <UserRound className="h-3.5 w-3.5" /> Open person page
            </Link>
            {(c.tags.length > 0 || c.groups.length > 0) && (
              <div className={cn("mt-2.5 flex flex-wrap gap-1.5", narrow ? "justify-center" : "justify-start")}>
                {c.groups.map((g) => (
                  <Chip key={g} className="h-7">
                    <Users className="h-3 w-3" />
                    {groupName(item.data.groups, g)}
                  </Chip>
                ))}
                <TagChips names={c.tags} />
              </div>
            )}
          </div>
        </div>
        {!onBack && (
          <div className={cn("flex shrink-0 items-center gap-1", narrow && "absolute right-0 top-0")}>
            {favButton}
            {can && !narrow && (
              <ItemButton size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(true)}>
                Edit
              </ItemButton>
            )}
            {moreMenu}
          </div>
        )}
      </div>

      {/* Birthday this week — the one thing to do right now. */}
      {bdayIn !== null && bdayIn <= 7 && (
        <div className="flex items-center gap-3 rounded-2xl border border-[color-mix(in_srgb,var(--item-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)] px-4 py-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--item-accent)] text-white">
            <Cake className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--text)]">
              {bdayIn === 0 ? "Birthday today" : bdayIn === 1 ? "Birthday tomorrow" : `Birthday ${inDaysLabel(bdayIn).toLowerCase()}`}
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              {fmtDate(bdayNext, { year: false })}
              {turns ? ` · turns ${turns}` : ""}
            </p>
          </div>
          <ItemButton size="sm" variant="primary" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={birthdayAsk} className="shrink-0 whitespace-nowrap">
            Draft a wish
          </ItemButton>
        </div>
      )}

      {/* Quick actions */}
      <div className="grid grid-cols-4 gap-2">
        <QuickAction href={phone ? telHref(phone, cc) : undefined} icon={Phone} label="Call" compact={!narrow} />
        <QuickAction href={phone ? smsHref(phone) : undefined} icon={MessageSquare} label="Message" compact={!narrow} />
        <QuickAction href={email ? `mailto:${email}` : undefined} icon={Mail} label="Email" compact={!narrow} />
        <QuickAction onClick={can ? () => setLogging(true) : undefined} icon={NotebookPen} label="Log" compact={!narrow} />
      </div>
      {/* Calls: they're on Promptly and you can call them there. */}
      {account?.user && account.can_call && (
        <div className="flex flex-wrap items-center gap-2" data-testid="contact-promptly-call">
          <span className="w-full text-xs text-[var(--text-muted)]">Call {first} on Promptly</span>
          <ItemButton
            variant="primary"
            className="flex-1"
            icon={<Phone className="h-4 w-4" />}
            aria-label={`Call ${first} on Promptly`}
            onClick={() => void calls.startWith([account.user!.id], "audio")}
          >
            Voice call
          </ItemButton>
          <ItemButton
            variant="secondary"
            className="flex-1"
            icon={<Video className="h-4 w-4" />}
            aria-label={`Video call ${first} on Promptly`}
            onClick={() => void calls.startWith([account.user!.id], "video")}
          >
            Video call
          </ItemButton>
        </div>
      )}

      {/* Ask AI */}
      <div className={cn("flex gap-2", narrow ? "-mx-4 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" : "flex-wrap")}>
        <Chip icon={<Sparkles className="h-3.5 w-3.5 text-[var(--item-accent)]" />} onClick={() => ask(`Brief me on ${name} before we next meet (contact id ${c.id}).`)}>
          Brief me
        </Chip>
        <Chip icon={<MessageSquare className="h-3.5 w-3.5 text-[var(--item-accent)]" />} onClick={() => ask(`Draft a short, warm check-in message I could send ${name} (contact id ${c.id}), based on what I know about them.`)}>
          Draft a message
        </Chip>
        {bdayIn !== null && bdayIn > 7 && bdayIn <= 14 && (
          <Chip icon={<Cake className="h-3.5 w-3.5 text-[var(--item-accent)]" />} onClick={birthdayAsk}>
            Birthday message
          </Chip>
        )}
        <Chip icon={<Gift className="h-3.5 w-3.5 text-[var(--item-accent)]" />} onClick={() => ask(`Suggest a few gift ideas for ${name} (contact id ${c.id}) from what I know about them, and save the good ones.`)}>
          Gift ideas
        </Chip>
      </div>

      <div className={cn("grid gap-4", mode === "wide" ? "grid-cols-2 items-start" : "grid-cols-1")}>
        <div className="flex min-w-0 flex-col gap-4">
          <ReachPanel c={c} cc={cc} />
          <KeepInTouch item={item} c={c} />
          <DatesPanel item={item} c={c} />
          <RelationsPanel item={item} c={c} onOpen={onOpen} />
          <PhotosPanel item={item} c={c} name={name} first={first} />
          {(c.met_how || c.met_where || c.met_date) && (
            <Panel title="How you met" icon={Handshake}>
              <p className="text-sm text-[var(--text)]">{c.met_how || "Met"}</p>
              <p className="text-xs text-[var(--text-muted)]">{[c.met_where, c.met_date ? fmtDate(c.met_date) : ""].filter(Boolean).join(" · ")}</p>
            </Panel>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <NoteList item={item} c={c} field="remember" title="Things to remember" icon={Lightbulb} placeholder="Kids: Mia 6, Leo 3 · allergic to nuts" />
          <NoteList item={item} c={c} field="topics" title="Follow up next time" icon={MessageSquare} placeholder="Ask how the new job is going" checkable doneLabel="Covered" />
          <NoteList item={item} c={c} field="gifts" title="Gift ideas" icon={Gift} placeholder="That climbing guidebook" checkable doneLabel="Given" />
          <FreeNotes item={item} c={c} />
          <Timeline item={item} c={c} first={first} onLog={() => setLogging(true)} />
          <LinkedSection
            thing={{ kind: "contact", id: `${item.fileId}:${c.id}` }}
            readOnly={!item.canEdit}
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
          />
        </div>
      </div>

      <ContactForm item={item} open={editing} onClose={() => setEditing(false)} contactId={c.id} />
      <LogSheet item={item} contactId={c.id} open={logging} onClose={() => setLogging(false)} />
      <Sheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        size="sm"
        title={`Delete ${name}?`}
        footer={
          <>
            <ItemButton variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </ItemButton>
            <ItemButton
              variant="danger"
              block
              onClick={() => {
                const copy = structuredClone(c);
                item.update((d) => removeContacts(d, new Set([c.id])));
                setConfirmDelete(false);
                onDeleted?.();
                // Putting it back also takes it out of the Trash.
                toast.success(`Deleted ${name}`, {
                  action: {
                    label: "Undo",
                    onClick: () => item.update((d) => void (d.contacts.some((x) => x.id === copy.id) || d.contacts.push(copy))),
                  },
                });
              }}
            >
              Delete
            </ItemButton>
          </>
        }
      >
        <p className="text-sm text-[var(--text-muted)]">
          Their details, notes and history go. People linked to them keep the name. They stay in the Trash for 30 days, so you can restore them.
        </p>
      </Sheet>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn("flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left text-sm hover:bg-[var(--hover)]", danger ? "text-[var(--danger)]" : "text-[var(--text)]")}
    >
      <Icon className="h-4 w-4 opacity-70" />
      {label}
    </button>
  );
}

function QuickAction({ href, onClick, icon: Icon, label, compact }: { href?: string; onClick?: () => void; icon: typeof Phone; label: string; compact?: boolean }) {
  const disabled = !href && !onClick;
  const cls = cn(
    "flex flex-col items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_10%,var(--surface))] font-medium transition",
    compact ? "h-[60px] gap-1 text-xs" : "h-[68px] gap-1.5 text-xs",
    disabled ? "pointer-events-none opacity-40" : "text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--item-accent)_18%,var(--surface))] active:scale-[0.97]",
  );
  const body = (
    <>
      <Icon className="h-5 w-5 text-[var(--item-accent)]" />
      {label}
    </>
  );
  if (href) {
    return (
      <a href={href} className={cls} aria-label={label}>
        {body}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cls} aria-disabled={disabled}>
      {body}
    </button>
  );
}

// ------------------------------------------------------------ keep in touch

function KeepInTouch({ item, c }: { item: Handle; c: Contact }) {
  const today = todayISO();
  const last = lastContacted(c);
  const due = dueOn(c, today);
  const can = item.canEdit;
  const n = due ? daysFrom(today, due) : null;
  const status =
    n === null ? null : n < 0 ? overdueLabel(-n) : n === 0 ? "Due today" : `Next catch-up ${inDaysLabel(n).toLowerCase()} · ${fmtDate(due, { year: false })}`;
  const custom = c.cadence_days && !CADENCES.some((x) => x.days === c.cadence_days);
  const setCadence = (days: number | null) =>
    editContact(item, c.id, (x) => {
      x.cadence_days = days;
      if (!days) x.snoozed_until = null;
    });
  const snooze = (days: number) => {
    const base = new Date();
    base.setDate(base.getDate() + days);
    const until = todayISO(base);
    editContact(item, c.id, (x) => {
      x.snoozed_until = until;
    });
  };
  return (
    <Panel title="Keep in touch" icon={AlarmClock}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-[var(--text-muted)]">Last contacted</span>
          <span className="font-medium tabular-nums text-[var(--text)]">
            {agoLabel(last, today)}
            {last && <span className="ml-1 text-[var(--text-muted)]">· {fmtDate(last)}</span>}
          </span>
        </div>
        <Field label="Rhythm">
          <Select disabled={!can} value={c.cadence_days ? String(c.cadence_days) : ""} onChange={(e) => setCadence(e.target.value ? Number(e.target.value) : null)}>
            <option value="">No reminders</option>
            {CADENCES.map((x) => (
              <option key={x.days} value={x.days}>
                {x.label}
              </option>
            ))}
            {custom && <option value={c.cadence_days!}>Every {c.cadence_days} days</option>}
          </Select>
        </Field>
        {status && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={cn("inline-flex min-h-[28px] items-center rounded-full px-2.5 text-xs font-semibold", n !== null && n <= 0 ? "bg-[var(--warning-bg)] text-[var(--warning)]" : "bg-[var(--surface-2)] text-[var(--text-muted)]")} aria-live="polite">
              {status}
              {c.snoozed_until && c.snoozed_until >= today && <span className="ml-1 font-normal text-[var(--text-muted)]">(snoozed)</span>}
            </span>
            {can && n !== null && n <= 3 && (
              <div className="flex gap-1.5">
                <ItemButton size="sm" variant="ghost" onClick={() => snooze(7)}>
                  Snooze a week
                </ItemButton>
                <ItemButton size="sm" variant="ghost" onClick={() => snooze(30)}>
                  A month
                </ItemButton>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------- reach

function ReachPanel({ c, cc }: { c: Contact; cc: string }) {
  if (!c.phones.length && !c.emails.length && !c.addresses.length && !c.websites.length) return null;
  return (
    <Panel title="Contact" icon={Phone}>
      <ul className="-mx-2 flex flex-col">
        {c.phones.map((p, i) => (
          <Row key={`p${i}`} label={p.label || "phone"} value={p.value} href={telHref(p.value, cc)}>
            <IconLink href={smsHref(p.value)} label={`Message ${p.value}`} icon={MessageSquare} />
            <IconLink href={telHref(p.value, cc)} label={`Call ${p.value}`} icon={Phone} />
          </Row>
        ))}
        {c.emails.map((e, i) => (
          <Row key={`e${i}`} label={e.label || "email"} value={e.value} href={`mailto:${e.value}`}>
            <IconLink href={`mailto:${e.value}`} label={`Email ${e.value}`} icon={Mail} />
          </Row>
        ))}
        {c.addresses.map((a, i) => (
          <Row key={`a${i}`} label={a.label || "address"} value={addressLines(a).join("\n")} href={mapsHref(a)} external>
            <IconLink href={mapsHref(a)} label="Open in maps" icon={MapPin} external />
          </Row>
        ))}
        {c.websites.map((w, i) => {
          const href = webHref(w.label, w.value);
          return (
            <Row key={`w${i}`} label={w.label || "website"} value={w.value.replace(/^https?:\/\/(www\.)?/, "")} href={href} external>
              {href && <IconLink href={href} label={`Open ${w.value}`} icon={Globe} external />}
            </Row>
          );
        })}
      </ul>
    </Panel>
  );
}

function Row({ label, value, href, external, children }: { label: string; value: string; href: string | undefined; external?: boolean; children?: ReactNode }) {
  const body = (
    <>
      <span className="block text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
      <span className={cn("block whitespace-pre-line break-words text-sm", href ? "text-[var(--item-accent)]" : "text-[var(--text)]")}>{value}</span>
    </>
  );
  return (
    <li className="flex min-h-[52px] items-center gap-2 rounded-xl px-2 hover:bg-[var(--hover)]">
      {href ? (
        <a href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer noopener" : undefined} className="min-w-0 flex-1 py-1.5">
          {body}
        </a>
      ) : (
        <div className="min-w-0 flex-1 py-1.5">{body}</div>
      )}
      {children}
    </li>
  );
}

function IconLink({ href, label, icon: Icon, external }: { href: string; label: string; icon: typeof Phone; external?: boolean }) {
  return (
    <a
      href={href}
      aria-label={label}
      title={label}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer noopener" : undefined}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover-strong,var(--hover))] hover:text-[var(--item-accent)]"
    >
      <Icon className="h-[18px] w-[18px]" />
    </a>
  );
}

// ------------------------------------------------------------------- dates

function DatesPanel({ item, c }: { item: Handle; c: Contact }) {
  const today = todayISO();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<"birthday" | "anniversary" | "other">("birthday");
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const parsed = parseDateInput(text);
  const rows: { key: string; label: string; date: string; dateId: string | null }[] = [];
  if (c.birthday) rows.push({ key: "bday", label: "Birthday", date: c.birthday, dateId: null });
  for (const d of c.dates) rows.push({ key: d.id, label: d.label || (d.kind === "anniversary" ? "Anniversary" : "Date"), date: d.date, dateId: d.id });
  rows.sort((a, b) => nextOccurrence(a.date, today).localeCompare(nextOccurrence(b.date, today)));
  const can = item.canEdit;
  if (!rows.length && !can) return null;
  return (
    <Panel
      title="Dates"
      icon={Cake}
      action={
        can && (
          <ItemButton
            size="sm"
            variant="ghost"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => {
              setKind(c.birthday ? "anniversary" : "birthday");
              setLabel("");
              setText("");
              setAdding(true);
            }}
          >
            Add
          </ItemButton>
        )
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">Add their birthday and you'll get a reminder on the day.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => {
            const occ = nextOccurrence(r.date, today);
            const n = daysFrom(today, occ);
            const yrs = yearsOn(r.date, occ);
            const age = r.dateId === null ? ageOf(r.date, today) : null;
            return (
              <li key={r.key} className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)] text-[var(--item-accent)]">
                  <span className="text-[10px] font-semibold uppercase leading-none">{new Date(2000, Number(occ.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: "short" })}</span>
                  <span className="text-sm font-bold leading-tight tabular-nums">{Number(occ.slice(8, 10))}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[var(--text)]">
                    {r.label}
                    {age !== null && !yrs && <span className="ml-1 font-normal text-[var(--text-muted)]">· {age}</span>}
                  </p>
                  <p className="text-xs text-[var(--text-muted)]">
                    {fmtDate(r.date)} · {inDaysLabel(n)}
                    {yrs ? (r.dateId === null ? ` · turns ${yrs}` : ` · ${yrs} years`) : ""}
                  </p>
                </div>
                {can && (
                  <button
                    type="button"
                    aria-label={`Remove ${r.label}`}
                    onClick={() =>
                      editContact(item, c.id, (x) => {
                        if (r.dateId === null) x.birthday = null;
                        else x.dates = x.dates.filter((d) => d.id !== r.dateId);
                      })
                    }
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        size="sm"
        title="Add a date"
        footer={
          <ItemButton
            variant="primary"
            block
            disabled={!parsed}
            onClick={() => {
              if (!parsed) return;
              const did = uid("d");
              const lab = label.trim().slice(0, 60) || (kind === "anniversary" ? "Anniversary" : "Important date");
              editContact(item, c.id, (x) => {
                if (kind === "birthday") x.birthday = parsed;
                else if (x.dates.length < 30 && !x.dates.some((d) => d.id === did))
                  x.dates.push({ id: did, label: lab, date: parsed, kind, remind: true });
              });
              setAdding(false);
            }}
          >
            Add
          </ItemButton>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="What">
            <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="birthday">Birthday</option>
              <option value="anniversary">Anniversary</option>
              <option value="other">Other date</option>
            </Select>
          </Field>
          {kind !== "birthday" && (
            <Field label="Label">
              <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "anniversary" ? "Wedding anniversary" : "Moved to Berlin"} />
            </Field>
          )}
          <Field label="Date" hint={parsed ? fmtDate(parsed) + (parsed.startsWith("--") ? " (no year)" : "") : "e.g. 15 March 1990, or 15 March without a year"}>
            <TextInput autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="15 March 1990" />
          </Field>
        </div>
      </Sheet>
    </Panel>
  );
}

// ----------------------------------------------------------- relationships

function RelationsPanel({ item, c, onOpen }: { item: Handle; c: Contact; onOpen: (id: string) => void }) {
  const [adding, setAdding] = useState(false);
  const byId = useMemo(() => new Map(item.data.contacts.map((x) => [x.id, x])), [item.data.contacts]);
  const can = item.canEdit;
  if (!c.relationships.length && !can) return null;
  return (
    <Panel title="People in their life" icon={Users} action={can && <ItemButton size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>Add</ItemButton>}>
      {c.relationships.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">Partner, kids, parents, colleagues — link them to other contacts or just add a name.</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {c.relationships.map((r) => {
            const other = r.contact_id ? byId.get(r.contact_id) : undefined;
            const body = (
              <>
                {other ? <ContactAvatar contact={other} size={32} /> : <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-2)] text-xs font-semibold text-[var(--text-muted)]">{(r.name[0] ?? "?").toUpperCase()}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text)]">{other ? displayName(other) : r.name}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{r.label || REL_LABELS[r.type]}</span>
                </span>
                {other && <Link2 className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />}
              </>
            );
            return (
              <li key={r.id} className="flex items-center gap-1">
                {other ? (
                  <button type="button" onClick={() => onOpen(other.id)} className="flex min-h-[48px] flex-1 items-center gap-3 rounded-xl px-2 text-left hover:bg-[var(--hover)]">
                    {body}
                  </button>
                ) : (
                  <div className="flex min-h-[48px] flex-1 items-center gap-3 px-2">{body}</div>
                )}
                {can && (
                  <button
                    type="button"
                    aria-label={`Remove ${other ? displayName(other) : r.name}`}
                    onClick={() => {
                      const rel = { id: r.id, type: r.type, contact_id: r.contact_id };
                      item.update((d) => unlinkRelationship(d, c.id, rel));
                    }}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <AddRelation item={item} c={c} open={adding} onClose={() => setAdding(false)} />
    </Panel>
  );
}

function AddRelation({ item, c, open, onClose }: { item: Handle; c: Contact; open: boolean; onClose: () => void }) {
  const [type, setType] = useState<RelType>("partner");
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (open) {
      setType("partner");
      setQ("");
      setPick(null);
      setLabel("");
    }
  }, [open]);
  const index = useMemo(() => (open ? buildIndex(item.data) : null), [open, item.data]);
  const hits = useMemo(() => {
    if (!index || !q.trim()) return [];
    return item.data.contacts.filter((x) => x.id !== c.id && matches(index, x.id, q)).slice(0, 6);
  }, [index, q, item.data.contacts, c.id]);
  const picked = pick ? item.data.contacts.find((x) => x.id === pick) : undefined;
  const save = () => {
    const nm = q.trim();
    if (!picked && !nm) return;
    const ids = { a: uid("r"), b: uid("r") };
    const lab = label.trim().slice(0, 40);
    const otherId = picked?.id ?? null;
    item.update((d) => {
      if (otherId) linkBothWays(d, c.id, type, otherId, lab, ids);
      else {
        const me = d.contacts.find((x) => x.id === c.id);
        if (me && me.relationships.length < 50 && !me.relationships.some((x) => x.id === ids.a))
          me.relationships.push({ id: ids.a, type, contact_id: null, name: nm.slice(0, 120), label: lab });
      }
    });
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Add to ${displayName(c)}'s people`}
      footer={
        <ItemButton variant="primary" block disabled={!picked && !q.trim()} onClick={save}>
          {picked ? `Link ${displayName(picked)}` : q.trim() ? `Add “${q.trim()}”` : "Add"}
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="They are their…">
          <Select value={type} onChange={(e) => setType(e.target.value as RelType)}>
            {REL_TYPES.map((t) => (
              <option key={t} value={t}>
                {t === "report" ? "Direct report" : REL_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Who" hint="Pick a contact to link both ways, or just type a name">
          <TextInput
            autoFocus
            value={picked ? displayName(picked) : q}
            onChange={(e) => {
              setPick(null);
              setQ(e.target.value);
            }}
            placeholder="Name"
          />
        </Field>
        {!picked && hits.length > 0 && (
          <ul className="-mt-1 overflow-hidden rounded-xl border border-[var(--border)]">
            {hits.map((h) => (
              <li key={h.id}>
                <button type="button" onClick={() => setPick(h.id)} className="flex min-h-[48px] w-full items-center gap-3 px-3 text-left hover:bg-[var(--hover)]">
                  <ContactAvatar contact={h} size={28} />
                  <span className="truncate text-sm text-[var(--text)]">{displayName(h)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Field label="Label (optional)">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="daughter, cousin, mentor…" />
        </Field>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------- remember lists

function NoteList({
  item,
  c,
  field,
  title,
  icon,
  placeholder,
  checkable,
  doneLabel,
}: {
  item: Handle;
  c: Contact;
  field: "remember" | "topics" | "gifts";
  title: string;
  icon: typeof Gift;
  placeholder: string;
  checkable?: boolean;
  doneLabel?: string;
}) {
  const [text, setText] = useState("");
  const [showDone, setShowDone] = useState(false);
  const list: Note[] = c[field];
  const open = checkable ? list.filter((n) => !n.done) : list;
  const done = checkable ? list.filter((n) => n.done) : [];
  const can = item.canEdit;
  if (!list.length && !can) return null;
  const add = () => {
    const t = text.trim();
    if (!t) return;
    const nid = uid(field[0]);
    const added = todayISO();
    editContact(item, c.id, (x) => {
      if (x[field].length < 100 && !x[field].some((y) => y.id === nid)) x[field].push({ id: nid, text: t.slice(0, 500), done: false, added });
    });
    setText("");
  };
  const toggle = (id: string, target: boolean) =>
    editContact(item, c.id, (x) => {
      const n = x[field].find((y) => y.id === id);
      if (n) n.done = target;
    });
  const remove = (id: string) =>
    editContact(item, c.id, (x) => {
      x[field] = x[field].filter((y) => y.id !== id);
    });
  const row = (n: Note) => (
    <li key={n.id} className="group flex min-h-[40px] items-start gap-2">
      {checkable ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={n.done}
          aria-label={`${doneLabel}: ${n.text}`}
          disabled={!can}
          onClick={() => toggle(n.id, !n.done)}
          className="-ml-2.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--hover)]"
        >
          <span
            aria-hidden
            className={cn(
              "flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 transition",
              n.done ? "border-[var(--item-accent)] bg-[var(--item-accent)] text-white" : "border-[color-mix(in_srgb,var(--text-muted)_70%,transparent)]",
            )}
          >
            {n.done && <Check className="h-3 w-3" strokeWidth={3} />}
          </span>
        </button>
      ) : (
        <span className="mt-[15px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--item-accent)]" aria-hidden />
      )}
      <span className={cn("min-w-0 flex-1 py-2.5 text-sm leading-snug text-[var(--text)]", n.done && "text-[var(--text-muted)] line-through")}>{n.text}</span>
      {can && (
        <button
          type="button"
          aria-label={`Delete ${n.text}`}
          onClick={() => remove(n.id)}
          className="flex h-10 w-10 md:h-9 md:w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)] md:opacity-40 md:focus-visible:opacity-100 md:group-hover:opacity-100 md:hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </li>
  );
  return (
    <Panel title={title} icon={icon}>
      {open.length > 0 && <ul className="flex flex-col">{open.map(row)}</ul>}
      {can && (
        <form
          className="mt-1 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <TextInput aria-label={`Add to ${title.toLowerCase()}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
          <button
            type="submit"
            aria-label="Add"
            disabled={!text.trim()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--item-accent)] text-white disabled:opacity-40 md:h-10 md:w-10"
          >
            <Plus className="h-4 w-4" />
          </button>
        </form>
      )}
      {done.length > 0 && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowDone((s) => !s)} aria-expanded={showDone} className="inline-flex h-8 items-center gap-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
            <ChevronDown className={cn("h-3.5 w-3.5 transition", showDone && "rotate-180")} />
            {doneLabel} ({done.length})
          </button>
          {showDone && <ul className="flex flex-col">{done.map(row)}</ul>}
        </div>
      )}
    </Panel>
  );
}

function FreeNotes({ item, c }: { item: Handle; c: Contact }) {
  const [text, setText] = useState(c.notes);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!dirty.current) setText(c.notes);
  }, [c.notes]);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  const commit = (v: string) => {
    dirty.current = false;
    if (v !== c.notes) editContact(item, c.id, (x) => {
      x.notes = v.slice(0, 20_000);
    });
  };
  if (!item.canEdit && !c.notes) return null;
  return (
    <Panel title="Notes" icon={StickyNote}>
      {item.canEdit ? (
        <TextArea
          aria-label="Notes"
          value={text}
          rows={4}
          placeholder="Anything worth knowing…"
          onChange={(e) => {
            dirty.current = true;
            setText(e.target.value);
            if (timer.current) window.clearTimeout(timer.current);
            const v = e.target.value;
            timer.current = window.setTimeout(() => commit(v), 900);
          }}
          onBlur={(e) => {
            if (timer.current) window.clearTimeout(timer.current);
            commit(e.target.value);
          }}
        />
      ) : (
        <p className="whitespace-pre-wrap text-sm text-[var(--text)]">{c.notes}</p>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- timeline

function Timeline({ item, c, first, onLog }: { item: Handle; c: Contact; first: string; onLog: () => void }) {
  const [all, setAll] = useState(false);
  const today = todayISO();
  const list = all ? c.interactions : c.interactions.slice(0, 8);
  return (
    <Panel title="History" icon={History} action={item.canEdit && <ItemButton size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={onLog}>Log</ItemButton>}>
      {c.interactions.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          Nothing logged yet. After you next talk to {first}, log it — what you talked about makes the next catch-up easy.
        </p>
      ) : (
        <ol className="relative flex flex-col gap-3 border-l border-[var(--border)] pl-5">
          {list.map((i) => {
            const M = INTERACTION_META[i.type];
            return (
              <li key={i.id} className="group relative">
                <span className="absolute -left-[31px] top-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--item-accent)]">
                  <M.icon className="h-3 w-3" />
                </span>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--text)]">
                      {M.verb}
                      <span className="ml-1.5 font-normal text-[var(--text-muted)] tabular-nums">
                        {fmtDate(i.date)} · {agoLabel(i.date, today)}
                      </span>
                    </p>
                    {i.notes && <p className="mt-0.5 whitespace-pre-wrap text-sm text-[var(--text-muted)]">{i.notes}</p>}
                  </div>
                  {item.canEdit && (
                    <button
                      type="button"
                      aria-label={`Delete the ${M.label.toLowerCase()} on ${fmtDate(i.date)}`}
                      onClick={() =>
                        editContact(item, c.id, (x) => {
                          x.interactions = x.interactions.filter((y) => y.id !== i.id);
                        })
                      }
                      className="flex h-10 w-10 md:h-8 md:w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)] md:opacity-40 md:focus-visible:opacity-100 md:group-hover:opacity-100 md:hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {c.interactions.length > 8 && (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-3 text-xs font-medium text-[var(--item-accent)]">
          {all ? "Show less" : `Show all ${c.interactions.length}`}
        </button>
      )}
    </Panel>
  );
}

/** The person page in a sheet — for opening someone from Keep in touch or Groups. */
export function ContactSheet({
  item,
  contactId,
  onClose,
  isPhone,
  ask,
}: {
  item: Handle;
  contactId: string | null;
  onClose: () => void;
  isPhone: boolean;
  ask: (p: string) => void;
}) {
  const [id, setId] = useState(contactId);
  useEffect(() => setId(contactId), [contactId]);
  return (
    <Sheet open={!!contactId && !!id} onClose={onClose} size="full">
      {id && (
        <div className="-mx-5">
          <ContactDetail
            item={item}
            contactId={id}
            isPhone={isPhone}
            ask={(p) => {
              onClose();
              ask(p);
            }}
            onOpen={setId}
            onDeleted={onClose}
          />
        </div>
      )}
    </Sheet>
  );
}
