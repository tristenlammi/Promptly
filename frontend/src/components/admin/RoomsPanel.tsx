/**
 * Admin → Rooms: the server-wide settings for Rooms, in one place.
 *
 * Cards: GIF search (the library, its key, how strict), link previews,
 * custom emoji limits, then pointers to Rooms settings that live elsewhere
 * (Calls, storage) so nobody has to hunt for them.
 *
 * ── Adding a setting ────────────────────────────────────────────────────
 * 1. Backend: add its key to ``SETTINGS`` in ``backend/app/rooms/settings.py``
 *    (``Bool``, ``Int(lo, hi)`` or ``Choice(...)``). No migration, no API
 *    change: ``/api/admin/rooms/settings`` already reads and saves it.
 * 2. Here: add one entry to ``ROWS`` below with its ``key``, the ``card`` it
 *    belongs on, a ``label`` and ``help``. The control is drawn from the
 *    kind the server reports (a switch, a number box or a menu).
 *    A new group of settings? Add a card to ``CARDS`` and use its id.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Nothing here shows an admin anyone's messages; these only change how
 * Rooms works for everyone.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clapperboard, HardDrive, Link2, MessagesSquare, PhoneCall, SmilePlus } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { apiClient } from "@/api/client";
import type { GifProvider, GifSearchConfig } from "@/api/rooms";
import { GifLibraryError, LIBRARY_NAMES, searchGifs } from "@/rooms/gifs";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { SettingsCard } from "./SettingsCard";

type Value = boolean | number | string;

interface Kind {
  kind: "bool" | "int" | "choice";
  default: Value;
  min?: number;
  max?: number;
  choices?: string[];
}

interface RoomsAdmin {
  settings: Record<string, Value>;
  kinds: Record<string, Kind>;
  gif_key_set: boolean;
  facts: { attachment_max_mb: number; attachments_per_message: number; saved_gifs_per_person: number; emoji_max_edge: number };
}

const KEY = ["admin", "rooms-settings"];

const roomsAdminApi = {
  async get(): Promise<RoomsAdmin> {
    return (await apiClient.get<RoomsAdmin>("/admin/rooms/settings")).data;
  },
  /** ``gif_key``: omit to leave it, "" to clear it. */
  async patch(body: { settings?: Record<string, Value>; gif_key?: string }): Promise<RoomsAdmin> {
    return (await apiClient.patch<RoomsAdmin>("/admin/rooms/settings", body)).data;
  },
};

// ------------------------------------------------------------------ rows

interface Row {
  /** The key in ``SETTINGS`` (backend/app/rooms/settings.py). */
  key: string;
  /** Which card it sits on (an id from ``CARDS``). */
  card: string;
  label: string;
  help?: string;
  /** For a menu: what each choice is called. */
  choiceLabels?: Record<string, string>;
  /** For a number: what it counts ("KB", "emoji"). */
  unit?: string;
}

/** The cards that are drawn from ``ROWS``, in order. (GIF search has its own
 *  card below: it has a key to enter and a test button.) */
const CARDS: { id: string; title: string; icon: ReactNode; intro?: string }[] = [
  {
    id: "links",
    title: "Link previews",
    icon: <Link2 className="h-4 w-4" />,
    intro:
      "When someone sends a link, this server fetches the page once and shows its name, a line about it and a small picture. People's devices never contact the site unless they tap the link. The site sees this server's address, not who sent the link.",
  },
  {
    id: "emoji",
    title: "Custom emoji",
    icon: <SmilePlus className="h-4 w-4" />,
    intro: "Each space's owner and admins can add their own emoji (Space settings → Emoji). These limits apply to every space.",
  },
  // Rows with ``card: "messages"`` appear here: voice messages, polls, read
  // receipts and the like. The card is hidden while it has no rows.
  { id: "messages", title: "Messages", icon: <MessagesSquare className="h-4 w-4" /> },
];

const ROWS: Row[] = [
  { key: "link_previews", card: "links", label: "Show a preview for links", help: "Off: links are just links. Previews already shown stay until their message is edited." },
  { key: "emoji_max_per_space", card: "emoji", label: "Most emoji a space can have", unit: "emoji" },
  { key: "emoji_max_kb", card: "emoji", label: "Largest emoji file", unit: "KB" },
  {
    key: "read_receipts",
    card: "messages",
    label: "Show Sent, Delivered and Seen in conversations",
    help: "Off: nobody on this server sees whether their message was delivered or read. Space rooms never show this.",
  },
  {
    key: "default_notify",
    card: "messages",
    label: "Notifications in a space someone has just joined",
    choiceLabels: { all: "Every message", mentions: "Only when they're mentioned", none: "Nothing" },
    help: "Where each person starts. They can change it for themselves, and spaces they're already in stay as they are.",
  },
  { key: "voice_messages", card: "messages", label: "Voice messages", help: "Off: the microphone button is hidden and none can be sent. Ones already sent still play." },
  { key: "voice_max_seconds", card: "messages", label: "Longest voice message", unit: "seconds" },
  {
    key: "voice_transcripts",
    card: "messages",
    label: "Write out what a voice message says",
    choiceLabels: {
      local: "Only with this server's own speech-to-text",
      cloud: "Also with a cloud speech-to-text service",
      off: "Never",
    },
    help: "The words appear under the recording and can be searched. With this server's own speech-to-text, recordings never leave it. If you allow a cloud service, every voice message is sent to that company to be written out. Nothing is written out if no speech-to-text is set up.",
  },
  { key: "polls", card: "messages", label: "Polls", help: "Off: nobody can ask a new poll. Polls already asked can still be voted on." },
  // ── Add new rows here (see the note at the top of this file). ──
];

const input =
  "rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const btn =
  "inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50";

type Save = (settings: Record<string, Value>) => void;

function SettingRow({ row, kind, value, save, busy }: { row: Row; kind: Kind | undefined; value: Value | undefined; save: Save; busy: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  if (!kind || value === undefined) return null; // an older server: it doesn't know this setting yet
  if (kind.kind === "bool") {
    return (
      <label className="flex items-start gap-2 text-sm text-[var(--text)]">
        <input type="checkbox" className="mt-0.5" checked={value === true} disabled={busy} onChange={(e) => save({ [row.key]: e.target.checked })} />
        <span>
          {row.label}
          {row.help && <span className="block text-xs text-[var(--text-muted)]">{row.help}</span>}
        </span>
      </label>
    );
  }
  if (kind.kind === "choice") {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm text-[var(--text)]">
          {row.label}
        </label>
        <select id={id} className={`${input} w-fit`} value={String(value)} disabled={busy} onChange={(e) => save({ [row.key]: e.target.value })}>
          {(kind.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {row.choiceLabels?.[c] ?? c}
            </option>
          ))}
        </select>
        {row.help && <p className="text-xs text-[var(--text-muted)]">{row.help}</p>}
      </div>
    );
  }
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (!Number.isInteger(n) || n === value) return;
    if ((kind.min !== undefined && n < kind.min) || (kind.max !== undefined && n > kind.max)) {
      toast.error(`${row.label}: a whole number from ${kind.min} to ${kind.max}.`);
      return;
    }
    save({ [row.key]: n });
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm text-[var(--text)]">
        {row.label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          className={`${input} w-28`}
          min={kind.min}
          max={kind.max}
          value={draft ?? String(value)}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        {row.unit && <span className="text-sm text-[var(--text-muted)]">{row.unit}</span>}
        <span className="text-xs text-[var(--text-muted)]">
          {kind.min} to {kind.max}
        </span>
      </div>
      {row.help && <p className="text-xs text-[var(--text-muted)]">{row.help}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ the panel

export function RoomsPanel() {
  const qc = useQueryClient();
  const { data, isError, refetch } = useQuery({ queryKey: KEY, queryFn: roomsAdminApi.get });
  const patch = useMutation({
    mutationFn: roomsAdminApi.patch,
    onSuccess: (row) => {
      qc.setQueryData(KEY, row);
      // Open Rooms pages pick the change up the next time they load.
      void qc.invalidateQueries({ queryKey: ["rooms", "bootstrap"] });
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't save that. Try again.")),
  });
  if (isError) {
    return (
      <p className="text-sm text-[var(--text-muted)]">
        Couldn't load the Rooms settings.{" "}
        <button type="button" className="font-medium text-[var(--accent-text,var(--accent))] hover:underline" onClick={() => void refetch()}>
          Try again
        </button>
      </p>
    );
  }
  if (!data) return null;
  const save: Save = (settings) => patch.mutate({ settings });
  return (
    <div className="flex flex-col gap-5">
      <GifCard data={data} save={save} saveKey={(gif_key) => patch.mutateAsync({ gif_key })} busy={patch.isPending} />
      {CARDS.map((card) => {
        const rows = ROWS.filter((r) => r.card === card.id && data.kinds[r.key]);
        if (rows.length === 0) return null;
        return (
          <SettingsCard key={card.id} title={card.title} icon={card.icon}>
            <div className="flex flex-col gap-4">
              {card.intro && <p className="text-xs text-[var(--text-muted)]">{card.intro}</p>}
              {rows.map((r) => (
                <SettingRow key={r.key} row={r} kind={data.kinds[r.key]} value={data.settings[r.key]} save={save} busy={patch.isPending} />
              ))}
              {card.id === "emoji" && (
                <p className="text-xs text-[var(--text-muted)]">An emoji can be up to {data.facts.emoji_max_edge} pixels on a side. PNG, JPEG, GIF and WebP only; location details are stripped.</p>
              )}
            </div>
          </SettingsCard>
        );
      })}
      <ElsewhereCard facts={data.facts} />
    </div>
  );
}

// ------------------------------------------------------------------ GIF search

const RATING_LABELS: Record<string, string> = {
  family: "Family (the strictest)",
  teen: "Teen (the usual choice)",
  all: "Everything",
};

function GifCard({ data, save, saveKey, busy }: { data: RoomsAdmin; save: Save; saveKey: (key: string) => Promise<unknown>; busy: boolean }) {
  const keyId = useId();
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const provider = String(data.settings.gif_provider) as GifProvider;
  const name = LIBRARY_NAMES[provider] ?? provider;
  const on = data.settings.gif_search === true;
  const typed = key.trim();

  // The test runs in this browser, the same way everyone's searches will:
  // both libraries' terms say requests must come from people's own devices.
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const cfg: GifSearchConfig = { provider, key: typed, rating: (data.settings.gif_rating as GifSearchConfig["rating"]) ?? "teen" };
      const page = await searchGifs(cfg, "", 0);
      setResult({ ok: true, message: page.gifs.length ? `The key works: ${name} answered.` : `${name} accepted the key but sent nothing back.` });
    } catch (e) {
      setResult({ ok: false, message: e instanceof GifLibraryError ? e.message : `Couldn't reach ${name} from this browser.` });
    } finally {
      setTesting(false);
    }
  };

  const store = async (value: string) => {
    setResult(null);
    try {
      await saveKey(value);
      setKey("");
      toast.success(value ? "Key saved." : "Key removed.");
    } catch {
      /* the mutation already said why */
    }
  };

  return (
    <SettingsCard
      title="GIF search"
      icon={<Clapperboard className="h-4 w-4" />}
      headerExtra={
        data.gif_key_set && on ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> On
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-[var(--text-muted)]">
          People can always send their own GIFs and keep favourites; that needs nothing here and stays on this server. This adds a search of a GIF library to the picker in Rooms.
        </p>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs leading-relaxed text-[var(--text-muted)]">
          <b className="text-[var(--text)]">What turning this on shares.</b> GIPHY and KLIPY both require searches and GIFs to go straight from each person's device to them: an app may
          not pass them through its own server or keep copies. So with this on, the library sees the internet address of anyone who opens the GIF search or views a library GIF in a
          conversation, and the words they search for. It is not told who they are or this server's address. The key below is given to signed-in people's browsers so they can search.
          Leave this off if that isn't acceptable; saved and uploaded GIFs work either way.
        </div>

        <label className="flex items-start gap-2 text-sm text-[var(--text)]">
          <input type="checkbox" className="mt-0.5" checked={on} disabled={busy} onChange={(e) => save({ gif_search: e.target.checked })} />
          <span>
            Let people search a GIF library
            <span className="block text-xs text-[var(--text-muted)]">
              {on && data.gif_key_set
                ? `On: the GIF picker in Rooms has a ${name} tab.`
                : on
                  ? "On, but there's no key yet, so the picker shows saved GIFs only."
                  : "Off: the picker shows each person's saved GIFs only."}
            </span>
          </span>
        </label>

        <div className="flex flex-wrap gap-x-6 gap-y-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm text-[var(--text)]">Library</span>
            <select className={`${input} w-fit`} value={provider} disabled={busy} onChange={(e) => save({ gif_provider: e.target.value })}>
              <option value="giphy">GIPHY</option>
              <option value="klipy">KLIPY</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-sm text-[var(--text)]">How strict</span>
            <select className={`${input} w-fit`} value={String(data.settings.gif_rating)} disabled={busy} onChange={(e) => save({ gif_rating: e.target.value })}>
              {(data.kinds.gif_rating?.choices ?? ["family", "teen", "all"]).map((c) => (
                <option key={c} value={c}>
                  {RATING_LABELS[c] ?? c}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="-mt-2 text-xs text-[var(--text-muted)]">
          {provider === "giphy"
            ? "GIPHY: make a free key at developers.giphy.com. A new key allows 100 searches an hour for the whole server; GIPHY reviews requests for more and may charge."
            : "KLIPY: make a free key in the partner panel at klipy.com. A test key allows 100 searches an hour; KLIPY lifts the limit when you ask for production access."}{" "}
          Changing the library means entering that library's key.
        </p>

        <div className="flex flex-col gap-1">
          <label htmlFor={keyId} className="text-sm text-[var(--text)]">
            {name} key
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={keyId}
              type="password"
              autoComplete="off"
              className={`${input} min-w-0 flex-1 basis-56`}
              value={key}
              placeholder={data.gif_key_set ? "A key is stored. Type a new one to replace it." : "Paste the key here"}
              onChange={(e) => {
                setKey(e.target.value);
                setResult(null);
              }}
            />
            <button type="button" className={`${btn} border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]`} disabled={!typed || testing} onClick={() => void test()}>
              {testing ? "Testing…" : "Test"}
            </button>
            <button type="button" className={`${btn} bg-[var(--accent-strong)] text-white hover:opacity-90`} disabled={!typed || busy} onClick={() => void store(typed)}>
              Save key
            </button>
            {data.gif_key_set && (
              <button type="button" className={`${btn} text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]`} disabled={busy} onClick={() => void store("")}>
                Remove key
              </button>
            )}
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            {data.gif_key_set ? "A key is stored (encrypted). It's never shown here again." : "No key stored."} Test tries the key you've typed from this browser, before you save it.
          </p>
          {result && <p className={`text-xs ${result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{result.message}</p>}
        </div>
      </div>
    </SettingsCard>
  );
}

// ------------------------------------------------------------------ settings that live elsewhere

function ElsewhereCard({ facts }: { facts: RoomsAdmin["facts"] }) {
  const link = "font-medium text-[var(--accent-text,var(--accent))] hover:underline";
  return (
    <SettingsCard title="Also for Rooms" icon={<MessagesSquare className="h-4 w-4" />}>
      <ul className="flex flex-col gap-3 text-sm text-[var(--text)]">
        <li className="flex items-start gap-2.5">
          <PhoneCall className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
          <span>
            <Link to="/admin?tab=calls" className={link}>
              Calls
            </Link>
            <span className="block text-xs text-[var(--text-muted)]">Voice channels and calls: turning them on, who can use them, how many people at once, and checking they work from outside.</span>
          </span>
        </li>
        <li className="flex items-start gap-2.5">
          <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
          <span>
            <Link to="/admin?tab=storage" className={link}>
              Storage
            </Link>
            <span className="block text-xs text-[var(--text-muted)]">Disk space. Files sent in Rooms are kept with the room, not in anyone's Files.</span>
          </span>
        </li>
      </ul>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-[var(--border)] pt-3 text-xs text-[var(--text-muted)]">
        <dt>Largest file in a message</dt>
        <dd className="text-[var(--text)]">{facts.attachment_max_mb} MB</dd>
        <dt>Files per message</dt>
        <dd className="text-[var(--text)]">{facts.attachments_per_message}</dd>
        <dt>Saved GIFs per person</dt>
        <dd className="text-[var(--text)]">{facts.saved_gifs_per_person}</dd>
        <dt>Who can make a space</dt>
        <dd className="text-[var(--text)]">Anyone on this server</dd>
        <dt>How long messages are kept</dt>
        <dd className="text-[var(--text)]">Until someone deletes them</dd>
      </dl>
      <p className="mt-2 text-xs text-[var(--text-muted)]">These last five are fixed for now; they're listed so you know what they are.</p>
    </SettingsCard>
  );
}
