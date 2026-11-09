import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Bookmark, Briefcase, Clock, Home, Loader2, MapPin, Star, Store, User, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { peopleHubApi } from "@/api/peopleHub";
import { useIsMobile } from "@/hooks/useIsMobile";
import { TextInput } from "@/items/ui";
import { fromContacts, fromSavedPlaces, fromSearch, keyAction, locationText, mergeSuggestions, nearFrom, type LocationSuggestion, type SuggestionKind } from "@/lib/locationSuggest";
import { mapsApi } from "@/maps/api";
import { useKnownPosition, useMapsReady } from "@/maps/useMapsReady";
import { cn } from "@/utils/cn";

const KIND_ICON: Record<SuggestionKind, LucideIcon> = {
  home: Home,
  work: Briefcase,
  favourite: Star,
  list: Bookmark,
  contact: User,
  recent: Clock,
  business: Store,
  address: MapPin,
  place: MapPin,
};

const KIND_LABEL: Record<SuggestionKind, string> = {
  home: "Home",
  work: "Work",
  favourite: "Saved place",
  list: "Saved place",
  contact: "Contact",
  recent: "Recent",
  business: "Business",
  address: "Address",
  place: "Place",
};

/** Suggestions start at this many typed characters. */
const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

interface Props {
  value: string;
  /** Typing (free text stays as typed) and picking both come through here. */
  onChange: (text: string) => void;
  /** A suggestion was chosen; ``onChange`` already has its text. */
  onPick?: (s: LocationSuggestion) => void;
  placeholder?: string;
  maxLength?: number;
  id?: string;
  "aria-label"?: string;
  /** Classes for the text box. */
  className?: string;
  /** Use only ``className`` for the box (no shared input look, no pin icon). */
  unstyled?: boolean;
  /** Suggestions push what's below them down (a panel that would clip a popup). */
  inlineList?: boolean;
}

/**
 * A "where" field that fills in as you type: your saved P Maps places (Home,
 * Work, favourites), Contacts with an address, and P Maps search (addresses,
 * and businesses OpenStreetMap knows), near where you are or else near Home.
 * Any typed text still goes as it is. When Maps isn't available it suggests
 * saved places and contacts only, or nothing — never an error.
 */
export function LocationInput({ value, onChange, onPick, placeholder = "Add a place", maxLength = 300, id, className, unstyled, inlineList, ...aria }: Props) {
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [debounced, setDebounced] = useState(value.trim());
  const [room, setRoom] = useState<{ up: boolean; max: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const phone = useIsMobile();

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [value]);
  const q = debounced.length >= MIN_CHARS ? debounced : "";
  const asking = armed && open && !!q;

  // Nothing is fetched until the field is first used.
  const mapsReady = useMapsReady(armed);
  const here = useKnownPosition(armed);
  const mine = useQuery({ queryKey: ["maps-mine"], queryFn: () => mapsApi.mine(), enabled: armed, staleTime: 60_000, retry: false });
  const near = nearFrom(here, mine.data?.places);
  const nearKey = near ? `${near.lat.toFixed(2)},${near.lon.toFixed(2)}` : null;

  const people = useQuery({
    queryKey: ["location-input", "contacts", q],
    queryFn: ({ signal }) => peopleHubApi.search(q, { details: true, signal }),
    enabled: asking,
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const search = useQuery({
    queryKey: ["location-input", "maps", q, nearKey],
    queryFn: ({ signal }) => mapsApi.search(q, near, signal),
    enabled: asking && mapsReady,
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });

  const suggestions = useMemo(
    () =>
      q
        ? mergeSuggestions(
            fromSavedPlaces(mine.data?.places ?? [], q),
            fromContacts(people.data ?? []),
            fromSearch(mapsReady ? search.data ?? [] : []),
          )
        : [],
    [q, mine.data, people.data, search.data, mapsReady],
  );
  // The last list stays up while you keep typing (no flicker), but goes as
  // soon as the text is too short to suggest anything.
  const shown = open && value.trim().length >= MIN_CHARS && suggestions.length > 0;
  const busy = asking && (people.isFetching || (mapsReady && search.isFetching));

  useEffect(() => setActive(-1), [q]);

  const pick = useCallback(
    (s: LocationSuggestion) => {
      onChange(locationText(s));
      onPick?.(s);
      setOpen(false);
      setActive(-1);
    },
    [onChange, onPick],
  );

  // Escape closes the list, not the dialog around it: dialogs listen on the
  // document in the capture phase, so this listens on the window, first.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.target !== input.current) return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown]);

  // On a phone, keep the list clear of the on-screen keyboard: bring the
  // field up as far as it goes, then put the list where there's room —
  // below, or above the field when the keyboard leaves too little below.
  const lifted = useRef(false);
  useLayoutEffect(() => {
    if (!shown) {
      lifted.current = false;
      return;
    }
    if (!phone || lifted.current) return;
    lifted.current = true;
    input.current?.scrollIntoView({ block: "start" });
  }, [shown, phone]);
  useLayoutEffect(() => {
    if (!shown || inlineList) return;
    const vv = window.visualViewport;
    const measure = () => {
      const el = input.current;
      const r = el?.getBoundingClientRect();
      if (!el || !r) return;
      let top = vv ? vv.offsetTop : 0;
      let bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      // The scrolling panel the field sits in (a sheet's body) clips the list too.
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) {
          const pr = p.getBoundingClientRect();
          top = Math.max(top, pr.top);
          bottom = Math.min(bottom, pr.bottom);
          break;
        }
      }
      const below = Math.floor(bottom - r.bottom - 8);
      const above = Math.floor(r.top - top - 8);
      // Flip only when what's in the list doesn't fit below.
      const need = Math.min(288, Math.max(120, list.current?.scrollHeight ?? 0));
      const up = need > below && above > below;
      setRoom({ up, max: Math.max(120, Math.min(288, up ? above : below)) });
    };
    measure();
    vv?.addEventListener("resize", measure);
    vv?.addEventListener("scroll", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      vv?.removeEventListener("resize", measure);
      vv?.removeEventListener("scroll", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [shown, inlineList, suggestions.length]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!shown && e.key === "ArrowDown" && value.trim().length >= MIN_CHARS) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    const act = keyAction(e.key, active, suggestions.length, shown);
    if (act.type === "move") {
      e.preventDefault();
      setActive(act.active);
    } else if (act.type === "pick") {
      e.preventDefault();
      pick(suggestions[act.index]);
    } else if (act.type === "close") {
      // Enter with nothing highlighted keeps the typed text and just closes.
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  };

  const box = {
    id,
    ref: input,
    value,
    placeholder,
    maxLength,
    "aria-label": aria["aria-label"],
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value);
      setOpen(true);
    },
    // Focus only gets ready; the list opens when you type (an event that
    // already has a place doesn't pop suggestions just for being edited).
    onFocus: () => setArmed(true),
    onBlur: () => {
      // A tap on a suggestion lands first.
      window.setTimeout(() => setOpen(false), 150);
    },
    onKeyDown: onKey,
    autoComplete: "off",
    enterKeyHint: "done" as const,
    role: "combobox",
    "aria-autocomplete": "list" as const,
    "aria-expanded": shown,
    "aria-controls": listId,
    "aria-activedescendant": shown && active >= 0 ? `${listId}-${active}` : undefined,
  };

  return (
    <div className="relative min-w-0 flex-1" data-location-input>
      {unstyled ? (
        <input {...box} className={className} />
      ) : (
        <>
          <MapPin className="pointer-events-none absolute left-3 top-[22px] h-4 w-4 -translate-y-1/2 text-[var(--text-muted)] md:top-5" aria-hidden />
          <TextInput {...box} className={cn("pl-9 pr-9", className)} />
        </>
      )}
      {busy && !unstyled && (
        <Loader2 className="pointer-events-none absolute right-3 top-[22px] h-4 w-4 -translate-y-1/2 animate-spin text-[var(--text-muted)] md:top-5" aria-hidden />
      )}
      {shown && (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label="Suggested places"
          style={!inlineList && room ? { maxHeight: room.max } : undefined}
          className={cn(
            "promptly-scroll overflow-y-auto overscroll-contain rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-1",
            inlineList
              ? "mt-1 max-h-56"
              : cn("absolute left-0 right-0 z-30 max-h-72 shadow-[var(--shadow-md)]", room?.up ? "bottom-full mb-1" : "top-full mt-1"),
          )}
        >
          {suggestions.map((s, i) => {
            const Icon = KIND_ICON[s.kind];
            const sub = s.address && s.address !== s.name ? s.address : KIND_LABEL[s.kind];
            return (
              <li
                key={s.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                data-kind={s.kind}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                onMouseMove={() => i !== active && setActive(i)}
                className={cn(
                  "flex min-h-12 cursor-pointer items-center gap-3 px-3 py-1.5 text-left hover:bg-[var(--hover)]",
                  i === active && "bg-[var(--hover)]",
                )}
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                    s.kind === "home" || s.kind === "work" || s.kind === "favourite" || s.kind === "list"
                      ? "bg-[color-mix(in_srgb,var(--item-accent,#D97757)_14%,transparent)] text-[var(--item-accent,#D97757)]"
                      : "bg-[var(--hover)] text-[var(--text-muted)]",
                  )}
                  title={KIND_LABEL[s.kind]}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--text)]">{s.name}</span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">{sub}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
