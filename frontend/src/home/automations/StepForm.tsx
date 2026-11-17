import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import type { Home, HomeEntity } from "@/api/home";
import { homeAutomationsApi, type FlowNode, type MusicChoice } from "@/api/homeAutomations";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { actionsFor, byRoom, canBeStep, changeChoice, COLOURS, colourName, DAY_NAMES, fromSchedule, stateChoice, stepWords, toSchedule } from "./steps";

/**
 * The picked step's settings, in plain words: which device, what to do with
 * it. Every choice is a list of what this home really has, so nothing has to
 * be typed but a kind of music or a wait.
 */

const field =
  "h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:opacity-60";
const label = "mb-1 block text-xs font-semibold text-[var(--text-muted)]";
const quiet =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-xs font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50";

type Patch = { type?: string; data: Record<string, unknown> };

function DevicePicker({
  id,
  home,
  value,
  keep,
  disabled,
  onPick,
}: {
  id: string;
  home: Home;
  value: { box?: unknown; entity?: unknown };
  keep: (e: HomeEntity) => boolean;
  disabled: boolean;
  onPick: (e: HomeEntity) => void;
}) {
  const groups = byRoom(home, keep);
  const current = value.entity ? `${value.box}|${value.entity}` : "";
  const known = home.entities.some((e) => `${e.box_id}|${e.id}` === current);
  return (
    <select
      id={id}
      className={field}
      disabled={disabled}
      value={current}
      onChange={(ev) => {
        const e = home.entities.find((x) => `${x.box_id}|${x.id}` === ev.target.value);
        if (e) onPick(e);
      }}
    >
      <option value="" disabled>Pick one…</option>
      {current && !known && <option value={current}>No longer in this home</option>}
      {groups.map((g) => (
        <optgroup key={g.room} label={g.room}>
          {g.list.map((e) => (
            <option key={`${e.box_id}|${e.id}`} value={`${e.box_id}|${e.id}`}>{e.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function Days({ value, disabled, onChange }: { value: number[]; disabled: boolean; onChange: (days: number[]) => void }) {
  const all = value.length === 0 || value.length === 7;
  return (
    <div role="group" aria-label="Days" className="flex flex-wrap gap-1.5">
      {DAY_NAMES.map((d, i) => {
        const on = all || value.includes(i);
        return (
          <button
            key={d}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => {
              const now = all ? DAY_NAMES.map((_, n) => n) : value;
              const next = now.includes(i) ? now.filter((x) => x !== i) : [...now, i].sort();
              onChange(next.length === 7 || next.length === 0 ? [] : next);
            }}
            className={cn("h-9 min-w-[42px] rounded-xl border px-2 text-xs font-medium transition", on ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent-text,var(--accent))]" : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]")}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

export function StepForm({ home, node, canEdit, onChange, onRemove }: { home: Home; node: FlowNode; canEdit: boolean; onChange: (patch: Patch) => void; onRemove: () => void }) {
  const d = node.data ?? {};
  const set = (more: Record<string, unknown>) => onChange({ data: { ...d, ...more } });
  const off = !canEdit;
  const words = stepWords(node, home);
  const isStart = node.type.startsWith("trigger.");
  const entity = home.entities.find((e) => e.id === d.entity && e.box_id === d.box);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{isStart ? "How it starts" : words.title}</p>
        <p className="text-sm text-[var(--text)]">{words.line}</p>
      </div>

      {isStart && (
        <>
          <div>
            <label htmlFor="start-kind" className={label}>Start it</label>
            <select
              id="start-kind"
              className={field}
              disabled={off}
              value={node.type}
              onChange={(e) => {
                const type = e.target.value;
                if (type === "trigger.schedule") onChange({ type, data: toSchedule({ time: "07:00", days: [] }) });
                else if (type === "trigger.home_state") onChange({ type, data: { box: "", entity: "", name: "", state: "on" } });
                else onChange({ type, data: {} });
              }}
            >
              <option value="trigger.manual">When someone asks</option>
              <option value="trigger.schedule">At a time</option>
              <option value="trigger.home_state">When a device changes</option>
            </select>
          </div>
          {node.type === "trigger.manual" && (
            <p className="text-xs text-[var(--text-muted)]">It runs when someone says or types one of its phrases to the assistant, or taps Run on the Home page.</p>
          )}
          {node.type === "trigger.schedule" && (
            <>
              <div>
                <label htmlFor="start-time" className={label}>At</label>
                <input id="start-time" type="time" className={field} disabled={off} value={fromSchedule(d).time} onChange={(e) => onChange({ data: toSchedule({ ...fromSchedule(d), time: e.target.value || "07:00" }) })} />
              </div>
              <div>
                <p className={label}>On</p>
                <Days value={fromSchedule(d).days} disabled={off} onChange={(days) => onChange({ data: toSchedule({ ...fromSchedule(d), days }) })} />
              </div>
              <p className="text-xs text-[var(--text-muted)]">Its phrases and the Run button still work too.</p>
            </>
          )}
          {node.type === "trigger.home_state" && (
            <>
              <div>
                <label htmlFor="start-device" className={label}>When</label>
                <DevicePicker id="start-device" home={home} value={d} keep={() => true} disabled={off} onPick={(e) => set({ box: e.box_id, entity: e.id, name: e.name })} />
              </div>
              <div>
                <label htmlFor="start-state" className={label}>Does this</label>
                <select id="start-state" className={field} disabled={off} value={d.state === "off" ? "off" : "on"} onChange={(e) => set({ state: e.target.value })}>
                  <option value="on">{changeChoice(entity).on}</option>
                  <option value="off">{changeChoice(entity).off}</option>
                </select>
              </div>
            </>
          )}
        </>
      )}

      {node.type === "home.device" && (
        <>
          <div>
            <label htmlFor="step-device" className={label}>Device</label>
            <DevicePicker
              id="step-device"
              home={home}
              value={d}
              keep={canBeStep}
              disabled={off}
              onPick={(e) => {
                const first = actionsFor(e)[0];
                set({ box: e.box_id, entity: e.id, name: e.name, action: first?.action ?? "turn_on", value: first?.value ?? null });
              }}
            />
            <p className="mt-1 text-xs text-[var(--text-muted)]">Lights, plugs, fans, scenes and speakers. Locks, doors and alarms can't be part of an automation.</p>
          </div>
          {entity && <DeviceAction entity={entity} data={d} disabled={off} set={set} />}
        </>
      )}

      {node.type === "home.lights" && (
        <>
          <div>
            <label htmlFor="step-room" className={label}>Room</label>
            <select
              id="step-room"
              className={field}
              disabled={off}
              value={d.area ? `${d.box}|${d.area}` : ""}
              onChange={(e) => {
                const [box, area] = e.target.value.split("|");
                set({ box, area, name: home.areas.find((a) => a.id === area)?.name ?? "" });
              }}
            >
              <option value="" disabled>Pick one…</option>
              {roomsWithLights(home).map((r) => (
                <option key={`${r.box}|${r.area}`} value={`${r.box}|${r.area}`}>{r.name}</option>
              ))}
            </select>
          </div>
          <OnOff id="step-lights" value={d.on !== false} disabled={off} onChange={(on) => set({ on })} />
        </>
      )}

      {node.type === "home.music" && <MusicStep home={home} data={d} disabled={off} set={set} />}

      {node.type === "flow.delay" && <Wait seconds={Number(d.seconds ?? 60)} disabled={off} onChange={(seconds) => set({ seconds })} />}

      {node.type === "control.home_state" && (
        <>
          <div>
            <label htmlFor="check-device" className={label}>Device</label>
            <DevicePicker id="check-device" home={home} value={d} keep={() => true} disabled={off} onPick={(e) => set({ box: e.box_id, entity: e.id, name: e.name })} />
          </div>
          <div>
            <label htmlFor="check-state" className={label}>Yes when it</label>
            <select id="check-state" className={field} disabled={off} value={d.state === "off" ? "off" : "on"} onChange={(e) => set({ state: e.target.value })}>
              <option value="on">{stateChoice(entity).on}</option>
              <option value="off">{stateChoice(entity).off}</option>
            </select>
          </div>
          <p className="text-xs text-[var(--text-muted)]">Join “Yes” and “No” to what should happen each way. A way with nothing joined just stops there.</p>
        </>
      )}

      {node.type === "control.time" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="check-from" className={label}>From</label>
              <input id="check-from" type="time" className={field} disabled={off} value={String(d.start ?? "18:00")} onChange={(e) => set({ start: e.target.value || "18:00" })} />
            </div>
            <div>
              <label htmlFor="check-to" className={label}>Until</label>
              <input id="check-to" type="time" className={field} disabled={off} value={String(d.end ?? "23:00")} onChange={(e) => set({ end: e.target.value || "23:00" })} />
            </div>
          </div>
          <div>
            <p className={label}>On</p>
            <Days value={(d.days as number[]) ?? []} disabled={off} onChange={(days) => set({ days })} />
          </div>
          <p className="text-xs text-[var(--text-muted)]">An end earlier than the start runs past midnight. Join “Yes” and “No” to what should happen each way.</p>
        </>
      )}

      {canEdit && !isStart && (
        <button type="button" onClick={onRemove} className="inline-flex h-9 items-center gap-1.5 self-start rounded-xl px-2 text-xs font-medium text-[var(--danger)] hover:bg-[var(--hover)]">
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove this step
        </button>
      )}
    </div>
  );
}

function roomsWithLights(home: Home): { box: string; area: string; name: string }[] {
  const names = new Map(home.areas.map((a) => [a.id, a.name]));
  const seen = new Map<string, { box: string; area: string; name: string }>();
  for (const e of home.entities) {
    if (e.domain !== "light" || !e.area || !names.has(e.area)) continue;
    seen.set(`${e.box_id}|${e.area}`, { box: e.box_id, area: e.area, name: names.get(e.area)! });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function OnOff({ id, value, disabled, onChange }: { id: string; value: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <div>
      <label htmlFor={id} className={label}>Turn them</label>
      <select id={id} className={field} disabled={disabled} value={value ? "on" : "off"} onChange={(e) => onChange(e.target.value === "on")}>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </div>
  );
}

function DeviceAction({ entity, data, disabled, set }: { entity: HomeEntity; data: Record<string, unknown>; disabled: boolean; set: (more: Record<string, unknown>) => void }) {
  const choices = actionsFor(entity);
  const index = Math.max(0, choices.findIndex((c) => c.action === data.action && (c.value === undefined || c.value === data.value)));
  const choice = choices[index];
  const light = (data.value && typeof data.value === "object" ? data.value : {}) as Record<string, unknown>;
  return (
    <>
      <div>
        <label htmlFor="step-action" className={label}>Do this</label>
        <select
          id="step-action"
          className={field}
          disabled={disabled}
          value={index}
          onChange={(e) => {
            const c = choices[Number(e.target.value)];
            const value = c.needs === "light" ? { bri: 50 } : c.needs === "percent" ? 30 : c.needs === "preset" ? 1 : c.value ?? null;
            set({ action: c.action, value });
          }}
        >
          {choices.map((c, i) => (
            <option key={`${c.action}-${i}`} value={i}>{c.name}</option>
          ))}
        </select>
      </div>
      {choice?.needs === "light" && (
        <>
          <div>
            <label htmlFor="step-bri" className={label}>Brightness: {typeof light.bri === "number" ? `${light.bri}%` : "as it is"}</label>
            <input
              id="step-bri"
              type="range"
              min={1}
              max={100}
              disabled={disabled}
              value={typeof light.bri === "number" ? light.bri : 50}
              onChange={(e) => set({ value: { ...light, bri: Number(e.target.value) } })}
              className="w-full accent-[var(--accent-strong)]"
            />
          </div>
          <div>
            <label htmlFor="step-colour" className={label}>Colour</label>
            <select
              id="step-colour"
              className={field}
              disabled={disabled}
              value={colourName(light)}
              onChange={(e) => {
                const c = COLOURS.find((x) => x.name === e.target.value);
                const { k: _k, rgb: _rgb, ...rest } = light;
                void _k;
                void _rgb;
                set({ value: { ...rest, ...(c?.value ?? {}), ...(c || typeof rest.bri === "number" ? {} : { bri: 50 }) } });
              }}
            >
              <option value="">Leave it as it is</option>
              {COLOURS.map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
        </>
      )}
      {choice?.needs === "percent" && (
        <div>
          <label htmlFor="step-percent" className={label}>{data.action === "volume" ? "Volume" : "Speed"}: {Number(data.value ?? 30)}{data.action === "volume" ? "" : "%"}</label>
          <input id="step-percent" type="range" min={0} max={100} disabled={disabled} value={Number(data.value ?? 30)} onChange={(e) => set({ value: Number(e.target.value) })} className="w-full accent-[var(--accent-strong)]" />
        </div>
      )}
      {choice?.needs === "preset" && (
        <div>
          <label htmlFor="step-preset" className={label}>Preset number</label>
          <input id="step-preset" type="number" min={1} max={20} className={field} disabled={disabled} value={Number(data.value ?? 1)} onChange={(e) => set({ value: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} />
          <p className="mt-1 text-xs text-[var(--text-muted)]">A favourite saved on the speaker itself, by its number.</p>
        </div>
      )}
    </>
  );
}

function Wait({ seconds, disabled, onChange }: { seconds: number; disabled: boolean; onChange: (seconds: number) => void }) {
  const inMinutes = seconds >= 60 && seconds % 60 === 0;
  const [unit, setUnit] = useState<"s" | "m">(inMinutes ? "m" : "s");
  const shown = unit === "m" ? Math.max(1, Math.round(seconds / 60)) : seconds;
  const clamp = (n: number, u: "s" | "m") => Math.max(1, Math.min(u === "m" ? 30 : 1800, Math.round(n) || 1));
  return (
    <div>
      <label htmlFor="step-wait" className={label}>Wait for</label>
      <div className="flex gap-2">
        <input id="step-wait" type="number" min={1} max={unit === "m" ? 30 : 1800} className={field} disabled={disabled} value={shown} onChange={(e) => onChange(clamp(Number(e.target.value), unit) * (unit === "m" ? 60 : 1))} />
        <select
          aria-label="Seconds or minutes"
          className={cn(field, "w-32")}
          disabled={disabled}
          value={unit}
          onChange={(e) => {
            const u = e.target.value as "s" | "m";
            setUnit(u);
            onChange(clamp(shown, u) * (u === "m" ? 60 : 1));
          }}
        >
          <option value="s">seconds</option>
          <option value="m">minutes</option>
        </select>
      </div>
      <p className="mt-1 text-xs text-[var(--text-muted)]">Up to 30 minutes. If the server restarts while it waits, the rest doesn't happen.</p>
    </div>
  );
}

function MusicStep({ home, data, disabled, set }: { home: Home; data: Record<string, unknown>; disabled: boolean; set: (more: Record<string, unknown>) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<MusicChoice[] | null>(null);
  const picking = Boolean(data.uri);
  const [mode, setMode] = useState<"kind" | "pick">(picking ? "pick" : "kind");
  const search = useMutation({
    mutationFn: () => homeAutomationsApi.music(home.id, String(data.box), q.trim()),
    onSuccess: setFound,
  });
  const volume = typeof data.volume === "number" ? data.volume : null;
  return (
    <>
      <div>
        <label htmlFor="music-speaker" className={label}>Speaker</label>
        <DevicePicker id="music-speaker" home={home} value={data} keep={(e) => e.domain === "media_player" && !e.careful} disabled={disabled} onPick={(e) => set({ box: e.box_id, entity: e.id, name: e.name })} />
      </div>
      <div>
        <label htmlFor="music-mode" className={label}>Play</label>
        <select
          id="music-mode"
          className={field}
          disabled={disabled}
          value={mode}
          onChange={(e) => {
            const m = e.target.value as "kind" | "pick";
            setMode(m);
            if (m === "kind") set({ uri: "", label: "" });
          }}
        >
          <option value="kind">A kind of music</option>
          <option value="pick">Something I pick</option>
        </select>
      </div>
      {mode === "kind" && (
        <div>
          <label htmlFor="music-kind" className={label}>What kind</label>
          <input id="music-kind" className={field} disabled={disabled} maxLength={120} placeholder="jazz, relaxing, 90s rock…" value={String(data.query ?? "")} onChange={(e) => set({ query: e.target.value, uri: "", label: "" })} />
          <p className="mt-1 text-xs text-[var(--text-muted)]">It starts a mix that fits. Leave it empty for something you've played here lately.</p>
        </div>
      )}
      {mode === "pick" && (
        <div className="flex flex-col gap-2">
          {picking && <p className="rounded-xl bg-[var(--hover)] px-3 py-2 text-sm text-[var(--text)]">{String(data.label || "Picked")}</p>}
          {!disabled && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (q.trim() && data.entity) search.mutate();
              }}
            >
              <label htmlFor="music-find" className="sr-only">Find music</label>
              <input id="music-find" className={field} value={q} maxLength={120} placeholder="An artist, album, song or playlist" onChange={(e) => setQ(e.target.value)} />
              <button type="submit" className={quiet} disabled={!q.trim() || !data.entity || search.isPending}>{search.isPending ? "Looking…" : "Find"}</button>
            </form>
          )}
          {!data.entity && <p className="text-xs text-[var(--text-muted)]">Pick the speaker first.</p>}
          {search.isError && <p role="alert" className="text-xs text-[var(--danger)]">{apiErrorMessage(search.error, "Couldn't search. Try again.")}</p>}
          {found && found.length === 0 && <p className="text-xs text-[var(--text-muted)]">Nothing found. Try other words.</p>}
          {found && found.length > 0 && (
            <ul className="flex flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]" aria-label="What was found">
              {found.map((r) => (
                <li key={r.uri}>
                  <button
                    type="button"
                    className={cn("flex w-full items-center px-3 py-2 text-left text-sm hover:bg-[var(--hover)]", data.uri === r.uri ? "font-medium text-[var(--accent-text,var(--accent))]" : "text-[var(--text)]")}
                    onClick={() => set({ uri: r.uri, label: r.words, query: "" })}
                  >
                    {r.words}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {picking && (
            <label className="flex items-center gap-2 text-sm text-[var(--text)]">
              <input type="checkbox" className="h-4 w-4 accent-[var(--accent-strong)]" disabled={disabled} checked={data.shuffle === true} onChange={(e) => set({ shuffle: e.target.checked })} />
              Shuffle it
            </label>
          )}
        </div>
      )}
      <div>
        <label className="flex items-center gap-2 text-sm text-[var(--text)]">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent-strong)]" disabled={disabled} checked={volume !== null} onChange={(e) => set({ volume: e.target.checked ? 30 : null })} />
          Set the volume first
        </label>
        {volume !== null && (
          <>
            <label htmlFor="music-volume" className="sr-only">Volume</label>
            <input id="music-volume" type="range" min={0} max={100} disabled={disabled} value={volume} onChange={(e) => set({ volume: Number(e.target.value) })} className="mt-2 w-full accent-[var(--accent-strong)]" />
            <p className="text-xs text-[var(--text-muted)]">Volume {volume}</p>
          </>
        )}
      </div>
    </>
  );
}
