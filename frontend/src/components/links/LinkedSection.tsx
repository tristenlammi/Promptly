import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AtSign,
  BookOpen,
  CalendarDays,
  CheckSquare,
  Contact,
  FileText,
  Folder,
  Image,
  Images,
  LayoutGrid,
  Lightbulb,
  Link2,
  MessageSquare,
  MessagesSquare,
  Plane,
  Plus,
  Receipt,
  Search,
  User,
  UtensilsCrossed,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  connectionsApi,
  type Connections,
  type Thing,
  type ThingKind,
  type ThingRef,
} from "@/api/connections";
import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";

/*
 * The one "Linked" section every detail view shows: things linked to this
 * one (two-way — the link shows on both sides), with "Link…" (a search
 * across apps) and remove; and below it "Mentioned in" — the docs, room
 * messages, chats and journal entries that mention it. The server only
 * returns entries the viewer can open, so there's nothing to filter here.
 */

export const KIND_ICONS: Record<ThingKind, LucideIcon> = {
  file: FileText,
  folder: Folder,
  photo: Image,
  album: Images,
  task: CheckSquare,
  recipe: UtensilsCrossed,
  trip: Plane,
  contact: Contact,
  txn: Receipt,
  journal: BookOpen,
  event: CalendarDays,
  person: User,
  user: User,
  witem: LayoutGrid,
  room_msg: MessageSquare,
  chat_msg: MessagesSquare,
  note: Lightbulb,
};

export const connectionsKey = (ref: ThingRef) => ["connections", ref.kind, ref.id] as const;

export function useConnections(ref: ThingRef | null) {
  return useQuery({
    queryKey: ref ? connectionsKey(ref) : ["connections", "_"],
    queryFn: () => connectionsApi.get(ref as ThingRef),
    enabled: Boolean(ref),
    staleTime: 30_000,
    retry: false,
  });
}

function ThingRow({
  thing,
  onRemove,
  removing,
  compact,
}: {
  thing: Thing;
  onRemove?: () => void;
  removing?: boolean;
  compact?: boolean;
}) {
  const Icon = KIND_ICONS[thing.kind] ?? Link2;
  const body = (
    <>
      {thing.thumb ? (
        <img src={thing.thumb} alt="" className="h-7 w-7 shrink-0 rounded-md object-cover" loading="lazy" />
      ) : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-2)] text-[var(--text-muted)]">
          {thing.emoji ? <span className="text-sm leading-none">{thing.emoji}</span> : <Icon className="h-3.5 w-3.5" />}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--text)]">{thing.title || "Untitled"}</span>
        {!compact && thing.subtitle && (
          <span className="block truncate text-xs text-[var(--text-muted)]">{thing.subtitle}</span>
        )}
      </span>
    </>
  );
  return (
    <li className="group flex items-center gap-1">
      {thing.href ? (
        <Link
          to={thing.href}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-[var(--surface-2)]"
          title={thing.title}
        >
          {body}
        </Link>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1">{body}</span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          aria-label={`Remove link to ${thing.title}`}
          title="Remove link"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] opacity-60 transition hover:bg-[var(--surface-2)] hover:text-[var(--text)] hover:opacity-100 disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}

/** A search across apps; ``onPick`` gets the chosen thing. Shared by the
 *  "Link…" dialog and anywhere else that needs "pick any thing". */
export function ThingSearch({
  onPick,
  exclude,
  autoFocus = true,
  placeholder = "Search tasks, events, files, contacts…",
}: {
  onPick: (thing: Thing) => void;
  exclude?: (thing: Thing) => boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setTerm(q.trim()), 180);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data, isFetching } = useQuery({
    queryKey: ["connections-search", term],
    queryFn: () => connectionsApi.search(term),
    enabled: term.length >= 1,
    staleTime: 15_000,
  });
  const results = useMemo(() => (data ?? []).filter((t) => !exclude?.(t)), [data, exclude]);
  const [hi, setHi] = useState(0);
  useEffect(() => setHi(0), [term]);

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 focus-within:border-[var(--accent)]">
        <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        <input
          autoFocus={autoFocus}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHi((h) => Math.min(h + 1, Math.max(results.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" && results[hi]) {
              e.preventDefault();
              onPick(results[hi]);
            }
          }}
          placeholder={placeholder}
          aria-label="Search across apps"
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
        />
      </label>
      <ul className="max-h-80 overflow-y-auto" role="listbox" aria-label="Results">
        {term.length === 0 ? (
          <li className="px-2 py-3 text-xs text-[var(--text-muted)]">Type to find something in any app.</li>
        ) : results.length === 0 ? (
          <li className="px-2 py-3 text-xs text-[var(--text-muted)]">{isFetching ? "Searching…" : "Nothing found."}</li>
        ) : (
          results.map((t, i) => {
            const Icon = KIND_ICONS[t.kind] ?? Link2;
            return (
              <li key={`${t.kind}:${t.id}`} role="option" aria-selected={i === hi}>
                <button
                  type="button"
                  onMouseEnter={() => setHi(i)}
                  onClick={() => onPick(t)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
                    i === hi ? "bg-[var(--accent)]/10" : "hover:bg-[var(--surface-2)]"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--text)]">{t.title || "Untitled"}</span>
                    {t.subtitle && <span className="block truncate text-xs text-[var(--text-muted)]">{t.subtitle}</span>}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{t.label}</span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

/**
 * "Linked" + "Mentioned in" for one thing. ``ref`` null renders nothing
 * (e.g. while the thing hasn't been saved yet). ``readOnly`` hides add /
 * remove (the lists still show).
 */
export function LinkedSection({
  thing,
  readOnly = false,
  className,
}: {
  thing: ThingRef | null;
  readOnly?: boolean;
  className?: string;
}) {
  const qc = useQueryClient();
  const { data, isError } = useConnections(thing);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = (other?: ThingRef) => {
    if (thing) void qc.invalidateQueries({ queryKey: connectionsKey(thing) });
    if (other) void qc.invalidateQueries({ queryKey: connectionsKey(other) });
  };

  const add = useMutation({
    mutationFn: (other: Thing) => connectionsApi.link(thing as ThingRef, { kind: other.kind, id: other.id }),
    onSuccess: (linked) => {
      if (thing) {
        qc.setQueryData<Connections>(connectionsKey(thing), (cur) =>
          cur
            ? { ...cur, linked: [linked, ...cur.linked.filter((l) => l.link_id !== linked.link_id)] }
            : cur
        );
      }
      refresh(linked);
      setPicking(false);
      setError(null);
    },
    onError: () => setError("Couldn't link that."),
  });
  const remove = useMutation({
    mutationFn: (l: Thing & { link_id: string }) => connectionsApi.unlink(l.link_id),
    onSuccess: (_v, l) => {
      if (thing) {
        qc.setQueryData<Connections>(connectionsKey(thing), (cur) =>
          cur ? { ...cur, linked: cur.linked.filter((x) => x.link_id !== l.link_id) } : cur
        );
      }
      refresh(l);
    },
    onError: () => setError("Couldn't remove that link."),
  });

  if (!thing || isError) return null;
  const linked = data?.linked ?? [];
  const mentioned = data?.mentioned_in ?? [];
  if (readOnly && linked.length === 0 && mentioned.length === 0) return null;

  return (
    <section className={cn("flex flex-col gap-3", className)} aria-label="Linked">
      <div>
        <div className="mb-1 flex items-center gap-1.5">
          <Link2 className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <h3 className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Linked{linked.length ? ` (${linked.length})` : ""}
          </h3>
          {!readOnly && (
            <button
              type="button"
              onClick={() => setPicking(true)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-[var(--accent)] transition hover:bg-[var(--accent)]/10"
            >
              <Plus className="h-3.5 w-3.5" />
              Link…
            </button>
          )}
        </div>
        {linked.length === 0 ? (
          !readOnly && (
            <p className="px-1.5 text-xs text-[var(--text-muted)]">
              Nothing linked yet. Link a file, photo, task, event, contact or anything else.
            </p>
          )
        ) : (
          <ul className="flex flex-col">
            {linked.map((l) => (
              <ThingRow
                key={l.link_id}
                thing={l}
                onRemove={!readOnly && l.can_remove ? () => remove.mutate(l) : undefined}
                removing={remove.isPending && remove.variables?.link_id === l.link_id}
              />
            ))}
          </ul>
        )}
        {error && <p className="mt-1 px-1.5 text-xs text-[var(--danger)]">{error}</p>}
      </div>

      {mentioned.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1.5">
            <AtSign className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Mentioned in ({mentioned.length})
            </h3>
          </div>
          <ul className="flex flex-col">
            {mentioned.map((m) => (
              <ThingRow key={`${m.kind}:${m.id}`} thing={m} />
            ))}
          </ul>
        </div>
      )}

      <Modal open={picking} onClose={() => setPicking(false)} title="Link to…" widthClass="max-w-md">
        <ThingSearch
          onPick={(t) => add.mutate(t)}
          exclude={(t) =>
            (t.kind === thing.kind && t.id === thing.id) ||
            linked.some((l) => l.kind === t.kind && l.id === t.id)
          }
        />
      </Modal>
    </section>
  );
}
