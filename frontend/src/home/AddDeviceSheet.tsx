import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Cloud, Radar, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { homeApi, type Home, type SetupStep } from "@/api/home";
import { Sheet } from "@/components/shared/Sheet";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { cannotDraw, missing, SetupStepView, startValues, toInput, type Values } from "./SetupStepView";

/**
 * "Add a device": what the home's box has found on the network, a list of
 * brands, and then that brand's own set-up steps, one at a time, drawn by
 * ``SetupStepView``. When it's done: a name and a room for what it brought.
 *
 * Whatever is typed into a step (a password, a key) goes to the box in one
 * request and is kept nowhere else.
 */

const primary =
  "inline-flex h-11 flex-1 items-center justify-center rounded-xl bg-[var(--accent-strong)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";
const quiet =
  "inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-[var(--border)] px-4 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const row =
  "flex min-h-12 w-full items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-2 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60";
const field =
  "h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

const NEW_ROOM = "__new__";

export function AddDeviceSheet({ open, home, onClose }: { open: boolean; home: Home; onClose: () => void }) {
  const qc = useQueryClient();
  const online = home.boxes.filter((b) => b.online);
  const [boxId, setBoxId] = useState<string | null>(null);
  const box = online.find((b) => b.id === boxId) ?? online[0] ?? null;
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [step, setStep] = useState<SetupStep | null>(null);
  const [values, setValues] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // After it's added: a name and a room for each thing it brought.
  const [named, setNamed] = useState<Record<string, { name: string; area: string; room: string }>>({});
  const live = useRef<{ box: string; flow: string } | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setAsked(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (open) {
      setStep(null);
      setProblem(null);
      setQ("");
      setNamed({});
    }
  }, [open]);

  const picking = open && !step && !!box;
  const found = useQuery({ queryKey: ["home", "found", home.id, box?.id], queryFn: () => homeApi.found(home.id, box!.id), enabled: picking, refetchInterval: 5000 });
  const brands = useQuery({ queryKey: ["home", "brands", home.id, box?.id, asked], queryFn: () => homeApi.brands(home.id, box!.id, asked), enabled: picking, staleTime: 60_000 });

  const show = (next: SetupStep) => {
    setStep(next);
    setValues(startValues(next));
    setProblem(null);
    live.current = next.kind === "done" || next.kind === "stopped" || next.kind === "elsewhere" || !box ? null : { box: box.id, flow: next.flow };
    if (next.kind === "done") {
      setNamed(Object.fromEntries((next.devices ?? []).map((d) => [d.device_id, { name: d.name, area: d.area, room: "" }])));
      void qc.invalidateQueries({ queryKey: ["home", "homes"] });
    }
  };
  const run = async (what: () => Promise<SetupStep>) => {
    setBusy(true);
    setProblem(null);
    try {
      show(await what());
    } catch (e) {
      setProblem(apiErrorMessage(e, "That didn't work. Try again."));
    } finally {
      setBusy(false);
    }
  };

  // "It's working on it": ask again until it isn't.
  useEffect(() => {
    if (!open || !box || step?.kind !== "wait") return;
    const t = window.setTimeout(() => void homeApi.setupGet(home.id, box.id, step.flow).then(show).catch(() => undefined), 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, box?.id, home.id]);

  const leave = () => {
    // Walking away mid-way: tell the box, so nothing is left half set up.
    if (live.current) void homeApi.setupAbort(home.id, live.current.box, live.current.flow);
    live.current = null;
    onClose();
  };
  const back = () => {
    if (live.current) void homeApi.setupAbort(home.id, live.current.box, live.current.flow);
    live.current = null;
    setStep(null);
    setProblem(null);
  };

  const saveNames = async () => {
    if (!box || step?.kind !== "done") return onClose();
    setBusy(true);
    setProblem(null);
    try {
      for (const d of step.devices ?? []) {
        const mine = named[d.device_id];
        if (!mine) continue;
        let area = mine.area;
        if (area === NEW_ROOM) area = mine.room.trim() ? (await homeApi.addRoom(home.id, box.id, mine.room.trim())).id : "";
        const change: { device_id: string; name?: string; area?: string } = { device_id: d.device_id };
        if (mine.name.trim() && mine.name.trim() !== d.name) change.name = mine.name.trim();
        if (area !== d.area) change.area = area;
        if (change.name !== undefined || change.area !== undefined) await homeApi.updateDevice(home.id, box.id, change);
      }
      void qc.invalidateQueries({ queryKey: ["home", "homes"] });
      onClose();
    } catch (e) {
      setProblem(apiErrorMessage(e, "Couldn't save that. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const title = !step ? "Add a device" : step.kind === "form" || step.kind === "menu" ? step.title : step.kind === "done" ? "Added" : step.brand_name;
  const lacking = step ? missing(step, values) : [];
  const footer = !box ? (
    <button type="button" className={quiet} onClick={onClose}>Close</button>
  ) : !step ? (
    <button type="button" className={quiet} onClick={onClose}>Close</button>
  ) : step.kind === "form" ? (
    <div className="flex w-full gap-2">
      <button type="button" className={quiet} onClick={back} disabled={busy}>Back</button>
      <button type="button" className={primary} disabled={busy || lacking.length > 0 || cannotDraw(step)} onClick={() => void run(() => homeApi.setupStep(home.id, box.id, step.flow, toInput(step, values)))}>
        {busy ? "Working…" : step.last ? "Add" : "Continue"}
      </button>
    </div>
  ) : step.kind === "done" ? (
    <button type="button" className={primary} disabled={busy} onClick={() => void saveNames()}>{busy ? "Saving…" : "Done"}</button>
  ) : step.kind === "stopped" || step.kind === "elsewhere" ? (
    <div className="flex w-full gap-2">
      <button type="button" className={quiet} onClick={back}>Pick another</button>
      <button type="button" className={primary} onClick={onClose}>Close</button>
    </div>
  ) : (
    <button type="button" className={quiet} onClick={back} disabled={busy}>Back</button>
  );

  return (
    <Sheet open={open} onClose={leave} title={title} size="md" footer={footer} dismissible={!step || step.kind === "done" || step.kind === "stopped" || step.kind === "elsewhere"}>
      {!box ? (
        <p className="text-sm text-[var(--text-muted)]">Your home box is offline, so devices can't be added right now. Check it has power and is plugged into your router.</p>
      ) : !step ? (
        <div className="flex flex-col gap-5">
          {online.length > 1 && (
            <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
              Add it through
              <select className={field} value={box.id} onChange={(e) => setBoxId(e.target.value)}>
                {online.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          )}
          <section aria-label="Found on your network">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--text)]"><Radar className="h-4 w-4 text-[var(--text-muted)]" aria-hidden /> Found on your network</h3>
            {found.isLoading && <p className="text-sm text-[var(--text-muted)]">Looking…</p>}
            {found.data && found.data.length === 0 && (
              <p className="text-sm text-[var(--text-muted)]">Nothing new right now. Make sure the device is switched on and on the same network as your box, or pick its brand below.</p>
            )}
            <div className="flex flex-col gap-2">
              {found.data?.map((f) => (
                <button key={f.flow} type="button" className={row} disabled={busy} onClick={() => void run(() => homeApi.setupGet(home.id, box.id, f.flow))}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--text)]">{f.name}</span>
                    {f.name !== f.brand_name && <span className="block truncate text-xs text-[var(--text-muted)]">{f.brand_name}</span>}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                </button>
              ))}
            </div>
          </section>
          <section aria-label="Add by brand">
            <h3 className="mb-2 text-sm font-semibold text-[var(--text)]">Add by brand</h3>
            <label className="relative mb-2 block">
              <span className="sr-only">Search brands</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search every brand" className={cn(field, "pl-9")} autoCorrect="off" spellCheck={false} />
            </label>
            {brands.isError && <p role="alert" className="text-sm text-[var(--danger)]">{apiErrorMessage(brands.error, "Couldn't get the list of brands.")}</p>}
            {brands.data && brands.data.length === 0 && <p className="text-sm text-[var(--text-muted)]">{asked ? `No brand called "${asked}".` : "No brands to show."}</p>}
            <div className="flex flex-col gap-2">
              {brands.data?.map((b) => (
                <button key={b.id} type="button" className={row} disabled={busy} onClick={() => void run(() => homeApi.setupStart(home.id, box.id, b.id))}>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
                      <span className="truncate">{b.name}</span>
                      {b.cloud && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--hover)] px-2 py-0.5 text-xs font-normal text-[var(--text-muted)]"><Cloud className="h-3 w-3" aria-hidden /> Through its cloud</span>}
                    </span>
                    {b.note && <span className="block text-xs text-[var(--text-muted)]">{b.note}</span>}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
                </button>
              ))}
            </div>
          </section>
          {problem && <p role="alert" className="text-sm text-[var(--danger)]">{problem}</p>}
        </div>
      ) : step.kind === "done" ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--text)]">{step.title} is added.</p>
          {(step.devices ?? []).length === 0 && <p className="text-sm text-[var(--text-muted)]">What it brings will show on your Home page in a moment.</p>}
          {(step.devices ?? []).map((d) => {
            const mine = named[d.device_id] ?? { name: d.name, area: d.area, room: "" };
            const put = (change: Partial<typeof mine>) => setNamed((n) => ({ ...n, [d.device_id]: { ...mine, ...change } }));
            return (
              <fieldset key={d.device_id} className="flex flex-col gap-2 rounded-xl border border-[var(--border)] p-3">
                <legend className="px-1 text-xs text-[var(--text-muted)]">{d.name}</legend>
                <label className="flex flex-col gap-1 text-sm font-medium text-[var(--text)]">
                  Name
                  <input className={field} value={mine.name} maxLength={80} onChange={(e) => put({ name: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium text-[var(--text)]">
                  Room
                  <select className={field} value={mine.area} onChange={(e) => put({ area: e.target.value })}>
                    <option value="">No room yet</option>
                    {home.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    <option value={NEW_ROOM}>A new room…</option>
                  </select>
                </label>
                {mine.area === NEW_ROOM && <input className={field} value={mine.room} maxLength={60} placeholder="Room name" aria-label="New room name" onChange={(e) => put({ room: e.target.value })} />}
              </fieldset>
            );
          })}
          {problem && <p role="alert" className="text-sm text-[var(--danger)]">{problem}</p>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <SetupStepView step={step} values={values} onChange={(name, v) => setValues((old) => ({ ...old, [name]: v }))} onPick={(option) => void run(() => homeApi.setupStep(home.id, box.id, step.flow, { next_step_id: option }))} />
          {step.kind === "form" && cannotDraw(step) && <p className="text-sm text-[var(--text-muted)]">This brand needs something Promptly can't ask for yet, so it can't be added here for now.</p>}
          {problem && <p role="alert" className="text-sm text-[var(--danger)]">{problem}</p>}
        </div>
      )}
    </Sheet>
  );
}
