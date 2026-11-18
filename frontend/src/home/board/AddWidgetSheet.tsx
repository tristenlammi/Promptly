import { ChevronLeft, ChevronRight, LayoutGrid, Lightbulb, Music, Rows3, Sparkles, Star, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Home, HomeEntity } from "@/api/home";
import { Sheet } from "@/components/shared/Sheet";
import { cn } from "@/utils/cn";

import { btn, field, strong } from "../DeviceControls";
import { keyOf } from "../kinds";
import { stateWords } from "../words";
import { MAX_ITEMS, NO_ROOM, pickable, roomsOf, scenesIn, speakersOf, type Widget } from "./layout";
import { iconOf } from "./Tile";

/**
 * "Add a widget": pick a kind, then what goes in it. Also opens on a group
 * or a set of scenes that's already on the page, to change its name and
 * what's in it.
 */

type Step = "menu" | "device" | "room" | "scenes" | "group";

const row =
  "flex min-h-14 w-full items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-2 text-left transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50";

function Option({ icon: Icon, title, text, onPick, disabled }: { icon: LucideIcon; title: string; text: string; onPick: () => void; disabled?: boolean }) {
  return (
    <li>
      <button type="button" className={row} disabled={disabled} onClick={onPick}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--hover)] text-[var(--accent-text,var(--accent))]"><Icon className="h-[18px] w-[18px]" aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-[var(--text)]">{title}</span>
          <span className="block text-xs text-[var(--text-muted)]">{text}</span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
      </button>
    </li>
  );
}

export function AddWidgetSheet({
  open,
  home,
  widgets,
  editing,
  onClose,
  onAdd,
  onChange,
}: {
  open: boolean;
  home: Home;
  /** What's on the page now (a room or "everything else" is only offered once). */
  widgets: Widget[];
  /** A group or scenes widget to change, instead of adding one. */
  editing: Widget | null;
  onClose: () => void;
  onAdd: (w: Omit<Widget, "id">) => void;
  onChange: (id: string, to: Partial<Widget>) => void;
}) {
  const [step, setStep] = useState<Step>("menu");
  const [name, setName] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) return;
    setQ("");
    if (editing) {
      setStep(editing.type === "scenes" ? "scenes" : "group");
      setName(editing.title ?? "");
      setTicked(editing.items ?? []);
    } else {
      setStep("menu");
      setName("");
      setTicked([]);
    }
  }, [open, editing]);

  const roomName = useMemo(() => {
    const by = new Map(home.areas.map((a) => [a.id, a.name]));
    return (e: HomeEntity) => (e.area && by.get(e.area)) || "";
  }, [home.areas]);
  const devices = useMemo(() => pickable(home).sort((a, b) => roomName(a).localeCompare(roomName(b)) || a.name.localeCompare(b.name)), [home, roomName]);
  const scenes = useMemo(() => scenesIn(home), [home]);
  const rooms = useMemo(() => {
    const placed = new Set(widgets.filter((w) => w.type === "room").map((w) => w.area ?? ""));
    return roomsOf(home).filter((r) => !placed.has(r.id));
  }, [home, widgets]);
  const hasRest = widgets.some((w) => w.type === "rest");
  const hasMusic = widgets.some((w) => w.type === "music");

  const add = (w: Omit<Widget, "id">) => {
    onAdd(w);
    onClose();
  };
  const tick = (key: string) => setTicked((t) => (t.includes(key) ? t.filter((k) => k !== key) : t.length >= MAX_ITEMS ? t : [...t, key]));
  const start = (to: Step, called = "") => {
    setStep(to);
    setName(called);
    setTicked([]);
    setQ("");
  };
  const finish = () => {
    const type = step === "scenes" ? "scenes" : "group";
    const title = name.trim().slice(0, 60) || (type === "scenes" ? "Scenes" : "Group");
    if (editing) {
      onChange(editing.id, { title, items: ticked });
      onClose();
    } else {
      add({ type, size: "m", title, items: ticked });
    }
  };

  const want = q.trim().toLowerCase();
  const match = (e: HomeEntity) => !want || e.name.toLowerCase().includes(want) || roomName(e).toLowerCase().includes(want);
  const picking = step === "scenes" || step === "group";
  const titles: Record<Step, string> = {
    menu: "Add a widget",
    device: "Which device?",
    room: "Which room?",
    scenes: editing ? "Change these scenes" : "Which scenes?",
    group: editing ? "Change this group" : "Which devices?",
  };

  const list = step === "scenes" ? scenes : devices;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={titles[step]}
      size="sm"
      footer={
        picking ? (
          <div className="flex w-full gap-2">
            <button type="button" className={btn} onClick={editing ? onClose : () => setStep("menu")}>{editing ? "Cancel" : "Back"}</button>
            <button type="button" className={strong} disabled={ticked.length === 0} onClick={finish}>{editing ? "Save" : ticked.length > 1 ? `Add ${ticked.length}` : "Add"}</button>
          </div>
        ) : step !== "menu" ? (
          <button type="button" className={cn(btn, "w-full")} onClick={() => setStep("menu")}><ChevronLeft className="h-4 w-4" aria-hidden /> Back</button>
        ) : undefined
      }
    >
      {step === "menu" && (
        <ul className="flex flex-col gap-2">
          <Option icon={Lightbulb} title="A device" text="One light, plug, speaker or reading. Bigger sizes show its slider or what's playing." onPick={() => start("device")} disabled={devices.length === 0} />
          <Option icon={LayoutGrid} title="A room" text="Everything in one room, with one switch for its lights." onPick={() => start("room")} disabled={rooms.length === 0} />
          <Option icon={Star} title="Favourites" text="The devices you use most, together, with one switch for them all." onPick={() => start("group", "Favourites")} disabled={devices.length === 0} />
          <Option icon={Rows3} title="A group of devices" text="Any devices you choose, under a name of your own." onPick={() => start("group")} disabled={devices.length === 0} />
          <Option icon={Sparkles} title="Scenes" text="One scene as a button, or several in a row." onPick={() => start("scenes")} disabled={scenes.length === 0} />
          <Option icon={Music} title="Music" text="What's playing, with play, skip and volume, on the speaker you pick." onPick={() => add({ type: "music", size: "m" })} disabled={hasMusic || speakersOf(home).length === 0} />
          {!hasRest && <Option icon={LayoutGrid} title="Everything else" text="Every room that has no widget of its own, so a new room still shows up." onPick={() => add({ type: "rest", size: "l" })} />}
        </ul>
      )}

      {step === "room" && (
        <ul className="flex flex-col gap-2" aria-label="Rooms">
          {rooms.map((r) => (
            <li key={r.id || "none"}>
              <button type="button" className={row} onClick={() => add({ type: "room", size: "l", area: r.id, title: r.name })}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text)]">{r.name}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{r.list.length === 1 ? "1 thing" : `${r.list.length} things`}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {(step === "device" || picking) && (
        <div className="flex flex-col gap-3">
          {step === "group" && (
            <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
              Name
              <input className={field} value={name} maxLength={60} placeholder="Group" onChange={(ev) => setName(ev.target.value)} />
            </label>
          )}
          {step === "scenes" && (
            <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
              Name (shown when there's more than one)
              <input className={field} value={name} maxLength={60} placeholder="Scenes" onChange={(ev) => setName(ev.target.value)} />
            </label>
          )}
          {list.length > 8 && <input className={field} value={q} placeholder="Search" aria-label="Search" onChange={(ev) => setQ(ev.target.value)} />}
          <ul className="flex flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]" aria-label={step === "scenes" ? "Scenes" : "Devices"}>
            {list.filter(match).map((e) => {
              const key = keyOf(e);
              const Icon = step === "scenes" ? Sparkles : iconOf(e);
              const inside = (
                <>
                  <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--text)]">{e.name}</span>
                    <span className="block truncate text-xs text-[var(--text-muted)]">{[roomName(e) || NO_ROOM, step === "scenes" ? "" : stateWords(e)].filter(Boolean).join(" · ")}</span>
                  </span>
                </>
              );
              return (
                <li key={key}>
                  {picking ? (
                    <label className="flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-[var(--hover)]">
                      {inside}
                      <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--accent)]" checked={ticked.includes(key)} onChange={() => tick(key)} aria-label={e.name} />
                    </label>
                  ) : (
                    <button type="button" className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]" onClick={() => add({ type: "device", size: "s", key, title: e.name })}>
                      {inside}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {picking && ticked.length >= MAX_ITEMS && <p className="text-xs text-[var(--text-muted)]">That's as many as one widget holds.</p>}
        </div>
      )}
    </Sheet>
  );
}
