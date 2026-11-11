import { AlarmClock, Cake, CalendarHeart, Check, HeartHandshake, MessageSquare, NotebookPen, Sparkles, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { EmptyState, Field, ItemButton, List, ListRow, Page, Section, Select, Sheet, Stat, StatGrid, TextInput, todayISO } from "@/items/ui";
import type { ItemViewProps } from "@/items/types";
import { cn } from "@/utils/cn";

import { ContactSheet } from "./ContactDetail";
import { LogSheet } from "./LogSheet";
import { CADENCES, agoLabel, buildIndex, cadenceLabel, daysFrom, displayName, fmtDate, inDaysLabel, matches, reconnectList, smsHref, sortContacts, upcomingDates } from "./model";
import { ContactAvatar, editContact, overdueLabel, useWidth, type Handle } from "./shared";
import type { ContactsData } from "./types";

/*
 * Keep in touch — the daily "who should I reach out to?" page: overdue and
 * upcoming catch-ups by each person's rhythm, birthdays (with the age they
 * turn) and anniversaries in the next month.
 */

export function KeepInTouchView({ item, isPhone, ask }: ItemViewProps<ContactsData>) {
  const data = item.data;
  const today = todayISO();
  const [open, setOpen] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const twoCol = !isPhone && width >= 860;

  const due = useMemo(() => reconnectList(data, 0, today), [data, today]);
  const soon = useMemo(() => reconnectList(data, 14, today).filter((r) => r.due > today), [data, today]);
  const dates = useMemo(() => upcomingDates(data, 30, today), [data, today]);
  const now = dates.filter((d) => d.inDays <= 1);
  const birthdays = dates.filter((d) => d.kind === "birthday" && d.inDays > 1);
  const others = dates.filter((d) => d.kind !== "birthday" && d.inDays > 1);
  const birthdayCount = dates.filter((d) => d.kind === "birthday").length;
  const onRhythm = useMemo(() => data.contacts.filter((c) => c.cadence_days).length, [data.contacts]);
  const recent = useMemo(() => {
    const from = new Date();
    from.setDate(from.getDate() - 30);
    const since = todayISO(from);
    let n = 0;
    for (const c of data.contacts) for (const i of c.interactions) if (i.date >= since) n++;
    return n;
  }, [data.contacts]);
  const order = data.settings.name_order;
  const DUE_LIMIT = isPhone ? 6 : 10;
  const dueShown = showAll ? due : due.slice(0, DUE_LIMIT);

  const snooze = (id: string, days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const until = todayISO(d);
    editContact(item, id, (x) => {
      x.snoozed_until = until;
    });
  };

  const dueSection = (
    <Section
      title={due.length ? `Due to reconnect · ${due.length}` : "Due to reconnect"}
      hint={due.length ? "Most overdue first — a two-line message counts." : undefined}
      action={
        onRhythm > 0 && (
          <ItemButton size="sm" variant="ghost" className="shrink-0 whitespace-nowrap" icon={<Sparkles className="h-3.5 w-3.5 text-[var(--item-accent)]" />} onClick={() => ask("Who should I catch up with this week, and what could I say to each? Keep it short.")}>
            Plan my week
          </ItemButton>
        )
      }
    >
      {onRhythm === 0 ? (
        <EmptyState
          icon={HeartHandshake}
          title="Pick who you want to stay close to"
          text="Give people a rhythm — weekly, monthly, every few months — and they'll show up here when it's time to say hi."
          action={
            item.canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <ItemButton variant="primary" onClick={() => setPicking(true)}>
                  Choose people
                </ItemButton>
                <ItemButton variant="ghost" onClick={() => ask("Suggest keep-in-touch rhythms for my contacts based on how close we seem, then set them.")}>
                  Ask the assistant
                </ItemButton>
              </div>
            )
          }
        />
      ) : due.length === 0 ? (
        <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--success-bg,var(--surface-2))] text-[var(--success)]">
            <Check className="h-5 w-5" />
          </span>
          <p className="text-sm text-[var(--text)]">
            You're all caught up.
            {soon[0] && <span className="block text-xs text-[var(--text-muted)]">Next: {displayName(soon[0].contact, order)} {inDaysLabel(daysFrom(today, soon[0].due)).toLowerCase()}.</span>}
          </p>
        </div>
      ) : (
        <>
          <List>
            {dueShown.map((r) => (
              <ListRow
                key={r.contact.id}
                onClick={() => setOpen(r.contact.id)}
                leading={<ContactAvatar contact={r.contact} size={40} />}
                title={displayName(r.contact, order)}
                subtitle={
                  <>
                    <span className={cn("font-medium", r.overdue >= 30 ? "text-[var(--warning)]" : "text-[var(--text)]")}>{overdueLabel(r.overdue)}</span>
                    {` · ${cadenceLabel(r.contact.cadence_days).toLowerCase()}`}
                    {!isPhone && ` · last ${agoLabel(r.last, today).toLowerCase()}`}
                  </>
                }
                action={
                  item.canEdit && (
                    <>
                      {!isPhone && (
                        <ItemButton size="sm" variant="ghost" onClick={() => snooze(r.contact.id, 7)} aria-label={`Snooze ${displayName(r.contact)} a week`}>
                          Snooze
                        </ItemButton>
                      )}
                      <ItemButton size="sm" icon={<NotebookPen className="h-3.5 w-3.5 text-[var(--item-accent)]" />} onClick={() => setLogFor(r.contact.id)} aria-label={`Log a catch-up with ${displayName(r.contact)}`}>
                        Log
                      </ItemButton>
                    </>
                  )
                }
              />
            ))}
          </List>
          {due.length > DUE_LIMIT && (
            <ItemButton size="sm" variant="ghost" className="self-start" onClick={() => setShowAll((s) => !s)}>
              {showAll ? "Show fewer" : `Show all ${due.length}`}
            </ItemButton>
          )}
        </>
      )}
    </Section>
  );

  const soonSection = soon.length > 0 && (
    <Section title="Coming up · next 2 weeks">
      <List>
        {soon.map((r) => (
          <ListRow
            key={r.contact.id}
            onClick={() => setOpen(r.contact.id)}
            leading={<ContactAvatar contact={r.contact} size={36} />}
            title={displayName(r.contact, order)}
            subtitle={`Last ${agoLabel(r.last, today).toLowerCase()} · ${cadenceLabel(r.contact.cadence_days).toLowerCase()}`}
            trailing={<span className="text-xs tabular-nums">{inDaysLabel(daysFrom(today, r.due))}</span>}
          />
        ))}
      </List>
    </Section>
  );

  const datesSection = (
    <>
      <Section title="Birthdays · next 30 days" hint={birthdayCount ? undefined : "Add birthdays on a person's page and they'll show here."}>
        {birthdays.length > 0 ? (
          <List>
            {birthdays.map((b) => (
              <ListRow
                key={b.contact.id}
                onClick={() => setOpen(b.contact.id)}
                leading={<DateBadge date={b.date} />}
                title={displayName(b.contact, order)}
                subtitle={[inDaysLabel(b.inDays), b.turns ? `turns ${b.turns}` : null].filter(Boolean).join(" · ")}
                action={
                  b.inDays <= 7 && (
                    <button
                      type="button"
                      onClick={() => ask(`Draft a thoughtful birthday message for ${displayName(b.contact)} (contact id ${b.contact.id}).`)}
                      className="inline-flex h-10 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]"
                    >
                      <Sparkles className="h-3.5 w-3.5" /> Wish
                    </button>
                  )
                }
              />
            ))}
          </List>
        ) : (
          birthdayCount > 0 && <p className="px-1 text-xs text-[var(--text-muted)]">Nothing else this month.</p>
        )}
      </Section>
      {others.length > 0 && (
        <Section title="Anniversaries & dates · next 30 days">
          <List>
            {others.map((d) => (
              <ListRow
                key={`${d.contact.id}-${d.dateId}`}
                onClick={() => setOpen(d.contact.id)}
                leading={<DateBadge date={d.date} />}
                title={displayName(d.contact, order)}
                subtitle={[d.label, inDaysLabel(d.inDays), d.turns ? `${d.turns} years` : null].filter(Boolean).join(" · ")}
                trailing={<CalendarHeart className="h-4 w-4" />}
              />
            ))}
          </List>
        </Section>
      )}
    </>
  );

  return (
    <Page wide>
      <div ref={box} className="flex flex-col gap-5">
        {/* Today first: the birthdays and dates that can't wait. */}
        {now.length > 0 && (
          <section aria-label="Today" className="overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--item-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--item-accent)_9%,var(--surface))]">
            <div className="flex items-center gap-2 px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-[var(--item-accent)]">
              <Cake className="h-4 w-4" /> Today &amp; tomorrow
            </div>
            <ul className={cn("grid gap-x-4", twoCol && now.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
              {now.map((d) => {
                const what = d.kind === "birthday" ? "Birthday" : d.label;
                const when = d.inDays === 0 ? "today" : "tomorrow";
                const phone = d.contact.phones[0]?.value;
                return (
                  <li key={`${d.contact.id}-${d.dateId ?? "b"}`} className="flex items-center gap-3 px-4 py-3">
                    <button type="button" onClick={() => setOpen(d.contact.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <ContactAvatar contact={d.contact} size={44} />
                      <span className="min-w-0">
                        <span className="block truncate text-[15px] font-semibold text-[var(--text)]">{displayName(d.contact, order)}</span>
                        <span className="block text-xs leading-snug text-[var(--text-muted)]">
                          {what} {when}
                          {d.turns ? (d.kind === "birthday" ? ` · turns ${d.turns}` : ` · ${d.turns} years`) : ""}
                        </span>
                      </span>
                    </button>
                    {phone && (
                      <a
                        href={smsHref(phone)}
                        aria-label={`Message ${displayName(d.contact)}`}
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface)] text-[var(--item-accent)] hover:bg-[var(--hover)]"
                      >
                        <MessageSquare className="h-[18px] w-[18px]" />
                      </a>
                    )}
                    <ItemButton
                      size="sm"
                      variant="primary"
                      className="shrink-0"
                      icon={<Sparkles className="h-3.5 w-3.5" />}
                      onClick={() =>
                        ask(
                          d.kind === "birthday"
                            ? `Draft a thoughtful birthday message for ${displayName(d.contact)} (contact id ${d.contact.id}).`
                            : `Draft a short message for ${displayName(d.contact)} (contact id ${d.contact.id}) for their ${d.label.toLowerCase()} ${when}.`,
                        )
                      }
                    >
                      Wish
                    </ItemButton>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {isPhone ? (
          <div className="grid grid-cols-3 divide-x divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-3">
            <MiniStat value={due.length} label="Due now" accent={due.length > 0} />
            <MiniStat value={birthdayCount} label="Birthdays · 30d" />
            <MiniStat value={recent} label="Catch-ups · 30d" />
          </div>
        ) : (
          <StatGrid>
            <Stat label="Due now" value={due.length} tone={due.length ? "accent" : "neutral"} icon={AlarmClock} />
            <Stat label="Birthdays · 30d" value={birthdayCount} icon={Cake} />
            <Stat label="Catch-ups · 30d" value={recent} icon={NotebookPen} />
            <Stat label="On a rhythm" value={onRhythm} unit={`of ${data.contacts.length}`} icon={Users} />
          </StatGrid>
        )}

        <div className={cn("grid gap-5", twoCol ? "grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] items-start" : "grid-cols-1")}>
          <div className="flex min-w-0 flex-col gap-5">
            {dueSection}
            {soonSection}
            {item.canEdit && onRhythm > 0 && (
              <ItemButton variant="ghost" size="sm" className="self-start" icon={<Users className="h-3.5 w-3.5 text-[var(--item-accent)]" />} onClick={() => setPicking(true)}>
                Set rhythms for more people · {onRhythm} of {data.contacts.length} on one
              </ItemButton>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-5">{datesSection}</div>
        </div>
      </div>

      <ContactSheet item={item} contactId={open} onClose={() => setOpen(null)} isPhone={isPhone} ask={ask} />
      <LogSheet item={item} contactId={logFor} open={!!logFor} onClose={() => setLogFor(null)} />
      <RhythmPicker item={item} open={picking} onClose={() => setPicking(false)} />
    </Page>
  );
}

function MiniStat({ value, label, accent }: { value: number; label: string; accent?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col items-center px-2">
      <span className={cn("text-xl font-semibold tabular-nums leading-tight", accent ? "text-[var(--item-accent)]" : "text-[var(--text)]")}>{value}</span>
      <span className="truncate text-[11px] text-[var(--text-muted)]">{label}</span>
    </div>
  );
}

function DateBadge({ date }: { date: string }) {
  return (
    <span className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)] text-[var(--item-accent)]" aria-label={fmtDate(date)}>
      <span className="text-[10px] font-semibold uppercase leading-none">{new Date(2000, Number(date.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: "short" })}</span>
      <span className="text-sm font-bold leading-tight tabular-nums">{Number(date.slice(8, 10))}</span>
    </span>
  );
}

/** Give many people a keep-in-touch rhythm at once. */
function RhythmPicker({ item, open, onClose }: { item: Handle; open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [days, setDays] = useState(30);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) {
      setQ("");
      setChosen(new Set(item.data.contacts.filter((c) => c.cadence_days).map((c) => c.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const index = useMemo(() => (open ? buildIndex(item.data) : null), [open, item.data]);
  const list = useMemo(() => {
    if (!index) return [];
    const all = sortContacts(item.data.contacts, item.data.settings.sort_by).filter((c) => matches(index, c.id, q));
    // Favourites first, then the people you talk to most.
    return [...all].sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.interactions.length - a.interactions.length).slice(0, 200);
  }, [index, item.data.contacts, item.data.settings.sort_by, q]);
  const apply = () => {
    const now = new Date().toISOString();
    item.update((d) => {
      for (const c of d.contacts) {
        if (chosen.has(c.id) && !c.cadence_days) {
          c.cadence_days = days;
          c.updated_at = now;
        }
      }
    });
    onClose();
  };
  const newly = [...chosen].filter((id) => !item.data.contacts.find((c) => c.id === id)?.cadence_days).length;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title="Who do you want to stay close to?"
      footer={
        <ItemButton variant="primary" block disabled={!newly} onClick={apply}>
          {newly ? `Set ${cadenceLabel(days).toLowerCase()} for ${newly}` : "Pick people"}
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Rhythm for the people you pick">
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {CADENCES.map((c) => (
                <option key={c.days} value={c.days}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Find">
            <TextInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, company, tag…" />
          </Field>
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          A gentle guide: closest people weekly, close friends and family every few weeks, good friends monthly to quarterly, the wider circle a few times a year.
        </p>
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)]">
          {list.map((c) => {
            const on = chosen.has(c.id);
            const fixed = !!c.cadence_days;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={fixed}
                  onClick={() =>
                    setChosen((s) => {
                      const n = new Set(s);
                      if (n.has(c.id)) n.delete(c.id);
                      else n.add(c.id);
                      return n;
                    })
                  }
                  className={cn("flex min-h-[52px] w-full items-center gap-3 px-3 text-left", !fixed && "hover:bg-[var(--hover)]")}
                >
                  <ContactAvatar contact={c} size={32} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{displayName(c)}</span>
                  {fixed ? (
                    <span className="text-xs text-[var(--text-muted)]">{cadenceLabel(c.cadence_days)}</span>
                  ) : (
                    <span className={cn("h-5 w-5 rounded-md border", on ? "border-[var(--item-accent)] bg-[var(--item-accent-fill)]" : "border-[var(--border)]")} aria-hidden />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Sheet>
  );
}
