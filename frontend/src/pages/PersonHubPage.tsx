import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ban,
  Cake,
  CalendarDays,
  CalendarPlus,
  ChevronRight,
  Contact as ContactIcon,
  ExternalLink,
  FileText,
  Folder,
  Hash,
  Heart,
  Images,
  Link2,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  Share2,
  UserRound,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { peopleHubApi, type PersonPage, type PersonRef } from "@/api/peopleHub";
import { roomsApi } from "@/api/rooms";
import { PersonAvatar } from "@/components/people/PeoplePicker";
import { LinkedSection } from "@/components/links/LinkedSection";
import { blockPerson, unblockPerson } from "@/components/people/blockActions";
import { Button } from "@/components/shared/Button";
import { fmt, parseYmd, sameDay, addDays, timeLabel } from "@/calendar/dates";
import { daysFrom, fmtDate, nextOccurrence } from "@/items/kinds/contacts/model";
import { birthdayLabel, contactPath, photosPersonPath } from "@/items/kinds/contacts/photosLink";
import { todayISO } from "@/items/ui";
import { BOOTSTRAP_KEY } from "@/rooms/cache";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/** Which person the URL names: /people/u/<user>, /people/c/<file>/<contact>, /people/p/<photos person>. */
function usePersonRef(): PersonRef | null {
  const { kind, a, b } = useParams();
  if (kind === "u" && a) return { kind: "u", userId: a };
  if (kind === "c" && a && b) return { kind: "c", fileId: a, contactId: b };
  if (kind === "p" && a) return { kind: "p", personId: a };
  return null;
}

/**
 * One person, everywhere (``/people/…``): their contact card, photos of
 * them, what's coming up with them, your conversations, and the files you've
 * shared — whichever of Contacts, Photos or their Promptly account you came
 * from. Only what you can already see anywhere else shows up here.
 */
export function PersonHubPage() {
  const ref = usePersonRef();
  const navigate = useNavigate();
  const { data: p, isLoading, isError, error } = useQuery({
    queryKey: ["people-hub", "person", ref],
    queryFn: () => peopleHubApi.get(ref!),
    enabled: !!ref,
    staleTime: 30_000,
  });

  const back = () => (window.history.length > 1 ? navigate(-1) : navigate("/chat"));

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto w-full max-w-3xl px-4 pb-10 pt-[max(1rem,env(safe-area-inset-top))]">
        <button type="button" onClick={back} className="-ml-2 mb-2 inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        {!ref || isError ? (
          <div className="rounded-2xl border border-dashed border-[var(--border)] p-8 text-center">
            <UserRound className="mx-auto mb-2 h-8 w-8 text-[var(--text-muted)]" />
            <p className="font-medium text-[var(--text)]">We couldn't find this person</p>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {isError ? apiErrorMessage(error, "They may have been removed, or this link isn't yours.") : "This link doesn't point at anyone."}
            </p>
          </div>
        ) : isLoading || !p ? (
          <div className="flex flex-col gap-3" aria-busy>
            <div className="h-24 animate-pulse rounded-2xl bg-[var(--hover)]" />
            <div className="h-32 animate-pulse rounded-2xl bg-[var(--hover)]" />
          </div>
        ) : (
          <PersonBody p={p} />
        )}
      </div>
    </div>
  );
}

function PersonBody({ p }: { p: PersonPage }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [opening, setOpening] = useState(false);
  const today = todayISO();
  const c = p.contact;
  const bday = birthdayLabel(c?.birthday, today);
  const anniversaries = (c?.dates ?? [])
    .filter((d) => d.kind === "anniversary")
    .map((d) => {
      const next = nextOccurrence(d.date, today);
      const inDays = daysFrom(today, next);
      return `${d.label || "Anniversary"} · ${inDays === 0 ? "today" : fmtDate(next, { year: false })}`;
    });
  const first = p.name.split(" ")[0] || p.name;
  const other = p.user && !p.is_me ? p.user : null;

  const message = async () => {
    if (!other) return;
    if (p.dm_room_id) {
      navigate(`/rooms/r/${p.dm_room_id}`);
      return;
    }
    setOpening(true);
    try {
      const room = await roomsApi.openDm([other.id]);
      await qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      navigate(`/rooms/r/${room.id}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't start the conversation."));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <section className="flex flex-col items-center gap-3 text-center sm:flex-row sm:items-center sm:text-left">
        {p.face || !c?.photo ? (
          <PersonAvatar person={p} size={88} />
        ) : (
          <img src={c.photo} alt="" aria-hidden className="h-[88px] w-[88px] shrink-0 rounded-full object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-[var(--text)]">{p.name}</h1>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5 text-sm text-[var(--text-muted)] sm:justify-start">
            {p.label && (
              <span className="inline-flex h-6 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-2.5 text-xs font-medium text-[var(--text)]">
                <Heart className="h-3 w-3" /> {p.label}
              </span>
            )}
            {p.is_me ? (
              <span>This is you</span>
            ) : p.user ? (
              <span>@{p.user.username} on Promptly</span>
            ) : (
              <span>Not on Promptly</span>
            )}
            {c && (c.title || c.company) && <span>· {[c.title, c.company].filter(Boolean).join(", ")}</span>}
          </div>
          {(bday || anniversaries.length > 0) && (
            <div className="mt-1.5 flex flex-wrap justify-center gap-x-3 gap-y-1 text-sm text-[var(--text-muted)] sm:justify-start">
              {bday && (
                <span className="inline-flex items-center gap-1">
                  <Cake className="h-3.5 w-3.5" /> {bday.line}
                </span>
              )}
              {anniversaries.map((a) => (
                <span key={a} className="inline-flex items-center gap-1">
                  <Heart className="h-3.5 w-3.5" /> {a}
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Actions */}
      {other && (
        <section className="grid grid-cols-3 gap-2">
          <ActionTile icon={<MessageCircle className="h-5 w-5" />} label="Message" onClick={() => void message()} busy={opening} />
          <ActionTile
            icon={<CalendarPlus className="h-5 w-5" />}
            label="Invite to event"
            onClick={() => navigate(`/calendar/?invite=${other.id}`, { state: { inviteUser: other } })}
          />
          <ActionTile icon={<Share2 className="h-5 w-5" />} label="Share my calendar" onClick={() => navigate("/calendar/?share=1")} />
        </section>
      )}
      {other && (
        <div className="-mt-2 flex flex-wrap items-center justify-center gap-x-2 text-xs text-[var(--text-muted)] sm:justify-start">
          {p.blocked && <span>You've blocked {first}. You can't message each other one-to-one.</span>}
          <button
            type="button"
            onClick={() => void (p.blocked ? unblockPerson(qc, other) : blockPerson(qc, other))}
            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-1.5 font-medium hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <Ban className="h-3.5 w-3.5" /> {p.blocked ? `Unblock ${first}` : `Block ${first}`}
          </button>
        </div>
      )}

      {/* Contact card */}
      <Section title="Contact" icon={<ContactIcon className="h-4 w-4" />}>
        {c ? (
          <div className="flex flex-col">
            {c.phones.map((x, i) => (
              <DetailRow key={`p${i}`} icon={<Phone className="h-4 w-4" />} label={x.label || "Phone"} value={x.value} href={`tel:${x.value.replace(/[^\d+]/g, "")}`} />
            ))}
            {c.emails.map((x, i) => (
              <DetailRow key={`e${i}`} icon={<Mail className="h-4 w-4" />} label={x.label || "Email"} value={x.value} href={`mailto:${x.value}`} />
            ))}
            {c.addresses.map((a, i) => {
              const line = [a.street, a.city, a.region, a.postcode, a.country].filter(Boolean).join(", ");
              return line ? <DetailRow key={`a${i}`} icon={<MapPin className="h-4 w-4" />} label={a.label || "Address"} value={line} /> : null;
            })}
            {c.phones.length + c.emails.length + c.addresses.length === 0 && (
              <p className="px-1 py-2 text-sm text-[var(--text-muted)]">No phone, email or address yet.</p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" leftIcon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => navigate(contactPath(c.file_id, c.contact_id))}>
                {c.can_edit ? "Edit in Contacts" : "Open in Contacts"}
              </Button>
            </div>
            {p.match === "name" && p.user && (
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                Matched to @{p.user.username} by name. Add their email to the contact to be sure it's them.
              </p>
            )}
          </div>
        ) : (
          <Empty
            text={p.is_me ? "You're not in your own Contacts." : `${first} isn't in your Contacts yet — add them there for their number, email and birthday.`}
            action={
              !p.is_me && (
                <Button size="sm" variant="secondary" leftIcon={<ContactIcon className="h-3.5 w-3.5" />} onClick={() => navigate("/apps/contacts")}>
                  Open Contacts
                </Button>
              )
            }
          />
        )}
      </Section>

      {/* Photos */}
      <Section
        title="Photos"
        icon={<Images className="h-4 w-4" />}
        extra={
          p.photos && p.photos.count > 0 ? (
            <Link to={photosPersonPath(p.photos.person_id)} className="inline-flex h-8 items-center gap-0.5 rounded-lg px-2 text-sm font-medium text-[var(--accent-text,var(--accent))] hover:bg-[var(--hover)]">
              See all {p.photos.count.toLocaleString()} <ChevronRight className="h-4 w-4" />
            </Link>
          ) : null
        }
      >
        {p.photos && p.photos.items.length > 0 ? (
          <div className="grid grid-cols-4 gap-1 sm:grid-cols-6">
            {p.photos.items.map((it) => (
              <Link key={it.id} to={photosPersonPath(p.photos!.person_id)} className="aspect-square overflow-hidden rounded-lg bg-[var(--hover)]">
                {it.thumb && <img src={it.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />}
              </Link>
            ))}
          </div>
        ) : p.photo_person_id ? (
          <Empty
            text={`No photos of ${first} in your library right now.`}
            action={<Button size="sm" variant="secondary" onClick={() => navigate(photosPersonPath(p.photo_person_id!))}>Open in Photos</Button>}
          />
        ) : (
          <Empty
            text={
              c
                ? `Not linked to anyone in your Photos. Name ${first} in Photos › People and link them to this contact to see their photos here.`
                : `Not linked to anyone in your Photos.`
            }
            action={
              <Button size="sm" variant="secondary" leftIcon={<Link2 className="h-3.5 w-3.5" />} onClick={() => navigate("/files/photos/people")}>
                Link in Photos
              </Button>
            }
          />
        )}
        {p.photo_person_id && !c && !p.is_me && (
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Link them to a contact from their{" "}
            <Link to={photosPersonPath(p.photo_person_id)} className="underline">
              Photos page
            </Link>{" "}
            to see their birthday and number here.
          </p>
        )}
      </Section>

      {other && (
        <>
          {/* Coming up */}
          <Section title="Coming up together" icon={<CalendarDays className="h-4 w-4" />}>
            {p.events.length ? (
              <ul className="flex flex-col">
                {p.events.map((e) => (
                  <li key={e.id}>
                    <Link to={`/calendar/?event=${e.event_id}`} className="flex min-h-12 items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
                      <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: e.color || "var(--accent)" }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[var(--text)]">{e.title}</span>
                        <span className="block truncate text-xs text-[var(--text-muted)]">
                          {whenText(e.start, e.all_day)}
                          {e.location ? ` · ${e.location}` : ""}
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text={`Nothing planned with ${first} in the next few months.`} />
            )}
          </Section>

          {/* Messages */}
          <Section title="Messages" icon={<MessageCircle className="h-4 w-4" />}>
            <div className="flex flex-col">
              <button type="button" onClick={() => void message()} className="flex min-h-12 items-center gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-[var(--hover)]">
                <MessageCircle className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 text-sm text-[var(--text)]">{p.dm_room_id ? `Your conversation with ${first}` : `Start a conversation with ${first}`}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              </button>
              {p.rooms.map((r) => (
                <Link key={r.room_id} to={`/rooms/r/${r.room_id}`} className="flex min-h-12 items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]">
                  <Hash className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{r.name}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                </Link>
              ))}
              {p.rooms.length === 0 && <p className="px-1 pt-1 text-xs text-[var(--text-muted)]">You aren't in any rooms together.</p>}
            </div>
          </Section>

          {/* Files */}
          <Section title="Shared files" icon={<FileText className="h-4 w-4" />}>
            {p.files.length ? (
              <ul className="flex flex-col">
                {p.files.map((f) => (
                  <li key={`${f.type}-${f.id}`}>
                    <Link
                      to={f.type === "folder" ? `/files/folder/${f.id}${f.direction === "theirs" ? "?scope=shared" : ""}` : `/files/f/${f.id}`}
                      className="flex min-h-12 items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-[var(--hover)]"
                    >
                      {f.type === "folder" ? <Folder className="h-4 w-4 shrink-0 text-[var(--text-muted)]" /> : <FileText className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-[var(--text)]">{f.name}</span>
                        <span className="block text-xs text-[var(--text-muted)]">{f.direction === "mine" ? `You shared with ${first}` : `${first} shared with you`}</span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty text={`You and ${first} haven't shared any files with each other.`} />
            )}
          </Section>
        </>
      )}

      {/* Links and mentions — on your contact for them if you have one,
          else their Photos person, else their account. */}
      <LinkedSection
        thing={
          c
            ? { kind: "contact", id: `${c.file_id}:${c.contact_id}` }
            : p.photo_person_id
              ? { kind: "person", id: p.photo_person_id }
              : p.user
                ? { kind: "user", id: p.user.id }
                : null
        }
        className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4"
      />
    </div>
  );
}

/** "Today · 7:00 PM", "Fri, Nov 14", in your time zone. */
function whenText(start: string, allDay: boolean): string {
  const now = new Date();
  const d = allDay ? parseYmd(start) : new Date(start);
  const day = sameDay(d, now) ? "Today" : sameDay(d, addDays(now, 1)) ? "Tomorrow" : fmt(d, { weekday: "short", month: "short", day: "numeric" });
  return allDay ? `${day} · All day` : `${day} · ${timeLabel(d)}`;
}

function Section({ title, icon, extra, children }: { title: string; icon: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[var(--text-muted)]">{icon}</span>
        <h2 className="flex-1 text-sm font-semibold text-[var(--text)]">{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 px-1 py-1">
      <p className="text-sm text-[var(--text-muted)]">{text}</p>
      {action}
    </div>
  );
}

function DetailRow({ icon, label, value, href }: { icon: ReactNode; label: string; value: string; href?: string }) {
  const body = (
    <>
      <span className="text-[var(--text-muted)]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-[var(--text)]">{value}</span>
        <span className="block text-xs capitalize text-[var(--text-muted)]">{label}</span>
      </span>
    </>
  );
  const cls = "flex min-h-12 items-center gap-3 rounded-lg px-1 py-1.5";
  return href ? (
    <a href={href} className={cn(cls, "hover:bg-[var(--hover)]")}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function ActionTile({ icon, label, onClick, busy }: { icon: ReactNode; label: string; onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-2 text-center text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-60 sm:text-sm"
    >
      <span className="text-[var(--accent-text,var(--accent))]">{icon}</span>
      {label}
    </button>
  );
}
