import { BarChart3, BookOpen, Dices, Plus, Users, X } from "lucide-react";
import { useState } from "react";

import type { ItemModule, ItemViewProps } from "@/items/types";
import { Chip, ItemButton, Page, TextInput, todayISO, uid } from "@/items/ui";
import { PersonInput } from "@/items/ui/PersonInput";
import { useAuthStore } from "@/store/authStore";

import { PlayerBadge } from "./bits";
import { GamesTab } from "./GamesTab";
import { PlayersTab } from "./PlayersTab";
import { PlayTab, requestStart } from "./PlayTab";
import { StatsTab } from "./StatsTab";
import type { Data, Player } from "./types";
import { PALETTE } from "./types";

/*
 * Game Night — score pad, plays log and stats for board games (backend:
 * app/items/kinds/boardgames). Tabs: Play (start/resume + the log), Games
 * (library + templates), Stats, Players.
 */

const STARTERS = [
  ["catan", "Catan"],
  ["wingspan", "Wingspan"],
  ["ticket-to-ride", "Ticket to Ride"],
  ["azul", "Azul"],
  ["7-wonders", "7 Wonders"],
  ["carcassonne", "Carcassonne"],
  ["codenames", "Codenames"],
  ["splendor", "Splendor"],
  ["yahtzee", "Yahtzee"],
  ["uno", "UNO"],
  ["terraforming-mars", "Terraforming Mars"],
  ["cascadia", "Cascadia"],
  ["pandemic", "Pandemic"],
  ["7-wonders-duel", "7 Wonders Duel"],
] as const;

function Onboarding({ item }: ItemViewProps<Data>) {
  // Your account name to start with — change it if friends know you otherwise.
  const [me, setMe] = useState(() => useAuthStore.getState().user?.username?.trim().slice(0, 60) ?? "");
  const [friend, setFriend] = useState("");
  const [friends, setFriends] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>(["catan", "ticket-to-ride", "codenames"]);
  const [busy, setBusy] = useState(false);

  const addFriend = (typed = friend) => {
    const parts = typed.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    setFriends((f) => [...f, ...parts.filter((p) => !f.some((x) => x.toLowerCase() === p.toLowerCase()))].slice(0, 20));
    setFriend("");
  };

  const finish = async (skip: boolean) => {
    setBusy(true);
    const names = skip ? [] : [me.trim(), ...friends].filter(Boolean);
    item.update((d) => {
      names.forEach((n, i) => {
        if (d.players.some((p) => p.name.toLowerCase() === n.toLowerCase())) return;
        const p: Player = { id: uid("p-"), name: n.slice(0, 60), color: PALETTE[d.players.length % PALETTE.length], favorite: false, archived: false, me: i === 0 && !!me.trim(), bgg_user: "", notes: "", created: todayISO() };
        d.players.push(p);
        if (p.me) d.settings.me_player_id = p.id;
      });
      d.settings.onboarded = true;
    });
    if (!skip && picked.length) {
      try {
        await item.runAction("add_from_template", { templates: picked });
      } catch {
        /* they can add games later */
      }
    }
    setBusy(false);
  };

  return (
    <Page>
      <div className="flex flex-col items-center gap-2 pt-4 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-[var(--item-accent-fill)] text-white shadow-[var(--shadow-md)]">
          <Dices className="h-8 w-8" />
        </span>
        <h1 className="text-2xl font-bold text-[var(--text)]">Game night, sorted</h1>
        <p className="max-w-sm text-sm text-[var(--text-muted)]">Keep score at the table, log every play and finally settle who's best at Catan.</p>
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-[var(--text)]">Your name</h2>
        <TextInput autoFocus value={me} onChange={(e) => setMe(e.target.value)} placeholder="e.g. Alex" aria-label="Your name" />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-[var(--text)]">Who do you play with?</h2>
        <div className="flex gap-2">
          <PersonInput
            value={friend}
            onChange={setFriend}
            onPick={(p) => addFriend(p.name.slice(0, 60))}
            onEnter={() => addFriend()}
            excludeNames={[me, ...friends]}
            placeholder="Sam, Jo, Priya…"
            aria-label="Friend's name"
          />
          <ItemButton onClick={() => addFriend()} disabled={!friend.trim()} icon={<Plus className="h-4 w-4" />}>
            Add
          </ItemButton>
        </div>
        {friends.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {friends.map((f, i) => (
              <span key={f} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--border)] py-1 pl-1 pr-1 text-sm text-[var(--text)]">
                <PlayerBadge player={{ name: f, color: PALETTE[(i + 1) % PALETTE.length] }} size={26} />
                {f}
                <button type="button" aria-label={`Remove ${f}`} onClick={() => setFriends((x) => x.filter((y) => y !== f))} className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]">
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-[var(--text)]">Games you play</h2>
        <p className="text-xs text-[var(--text-muted)]">Each comes with its official score sheet. Add more any time — or ask the assistant for anything not listed.</p>
        <div className="flex flex-wrap gap-2">
          {STARTERS.map(([id, name]) => (
            <Chip key={id} active={picked.includes(id)} onClick={() => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}>
              {name}
            </Chip>
          ))}
        </div>
      </section>
      <div className="flex flex-col gap-2 pb-6">
        <ItemButton variant="primary" size="lg" block disabled={busy || !me.trim()} onClick={() => void finish(false)}>
          {busy ? "Setting up…" : "Let's play"}
        </ItemButton>
        <ItemButton variant="ghost" block disabled={busy} onClick={() => void finish(true)}>
          Skip for now
        </ItemButton>
      </div>
    </Page>
  );
}

const module: ItemModule<Data> = {
  kind: "boardgames",
  tabs: [
    { id: "play", label: "Play", icon: Dices, View: PlayTab },
    { id: "games", label: "Games", icon: BookOpen, View: GamesTab },
    { id: "stats", label: "Stats", icon: BarChart3, View: StatsTab },
    { id: "players", label: "Players", icon: Users, View: PlayersTab },
  ],
  primaryAction: (h, { goTo }) =>
    h.canEdit
      ? {
          label: "New game",
          icon: <Plus className="h-4 w-4" />,
          onClick: () => {
            // The Play tab opens "Start a game" as soon as it's showing.
            requestStart(h.fileId, "");
            goTo("play");
          },
        }
      : null,
  needsOnboarding: (d) => !d.settings?.onboarded && (d.players?.length ?? 0) === 0 && (d.games?.length ?? 0) === 0,
  Onboarding,
};

export default module;
