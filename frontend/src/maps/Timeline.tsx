import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bike, Car, ChevronLeft, ChevronRight, Footprints, Loader2, MapPin, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { apiClient } from "@/api/client";
import { confirm } from "@/components/shared/ConfirmDialog";
import { isAndroidDevice } from "@/lib/installPrompt";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { formatDuration, formatKm, mapsApi } from "./api";
import { pointsFromExport } from "./timelineImport";
import { Choice, RowsSkeleton, SwitchRow } from "./ui";

interface Segment {
  type: "stay" | "move";
  start: string;
  end: string;
  name?: string;
  address?: string | null;
  saved?: boolean;
  lat?: number;
  lon?: number;
  km?: number;
  mode?: "walk" | "cycle" | "drive";
  line?: [number, number][];
}

interface Day {
  date: string;
  segments: Segment[];
  points: number;
  km: number;
  photos: { id: string; thumb: string }[];
}

const MODE = { walk: Footprints, cycle: Bike, drive: Car };
const MODE_LABEL = { walk: "Walk", cycle: "Cycle", drive: "Drive" };

function shift(day: string, by: number): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + by);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const lasted = (s: Segment) => formatDuration((new Date(s.end).getTime() - new Date(s.start).getTime()) / 1000);

export function TimelinePanel({ onClose, onShowDay }: { onClose: () => void; onShowDay: (day: { lines: [number, number][][]; stays: { lat: number; lon: number; name: string }[] }) => void }) {
  const qc = useQueryClient();
  const today = useMemo(() => shift(new Date().toISOString().slice(0, 10), 0), []);
  const [day, setDay] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ["maps-timeline", day],
    queryFn: async () => (await apiClient.get<Day>("/maps/timeline/day", { params: { date: day } })).data,
  });
  const { data: settings } = useQuery({
    queryKey: ["maps-timeline-settings"],
    queryFn: async () => (await apiClient.get<{ timeline_on: boolean; retention_days: number | null }>("/maps/timeline/settings")).data,
  });

  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!data || shown.current === data.date) return;
    shown.current = data.date;
    onShowDay({
      lines: data.segments.filter((s) => s.type === "move" && s.line).map((s) => s.line as [number, number][]),
      stays: data.segments.filter((s) => s.type === "stay" && s.lat !== undefined && s.lon !== undefined).map((s) => ({ lat: s.lat as number, lon: s.lon as number, name: s.name ?? "Somewhere" })),
    });
  }, [data, onShowDay]);

  const setRecording = async (on: boolean) => {
    if (on && isAndroidDevice()) {
      // The phone does the recording, and asks for the location permission it needs.
      try {
        const code = await mapsApi.pairCode();
        const params = new URLSearchParams({ server: window.location.origin, code, on: "1" });
        window.location.href = `promptlymaps://timeline?${params.toString()}`;
      } catch (e) {
        toast.error(apiErrorMessage(e, "Couldn't start the timeline."));
      }
      return;
    }
    if (on) {
      toast.info("Turn this on from the P Maps app on your Android phone: that's what records where you go.");
      return;
    }
    try {
      await apiClient.put("/maps/timeline/settings", { timeline_on: false });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't pause the timeline. It's still recording: try again."));
      return;
    }
    void qc.invalidateQueries({ queryKey: ["maps-timeline-settings"] });
    toast.success("Timeline paused. The phone stops the next time it checks in.");
  };

  const setRetention = async (days: number) => {
    try {
      await apiClient.put("/maps/timeline/settings", { retention_days: days || null });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't change how long your history is kept."));
      return;
    }
    void qc.invalidateQueries({ queryKey: ["maps-timeline-settings"] });
  };

  const removeDay = async () => {
    const ok = await confirm({
      title: "Delete this day?",
      message: "Everywhere you went on this day is deleted for good.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const start = new Date(`${day}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    try {
      await apiClient.delete("/maps/timeline", { params: { start: start.toISOString(), end: end.toISOString() } });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't delete this day."));
      return;
    }
    shown.current = null;
    void qc.invalidateQueries({ queryKey: ["maps-timeline", day] });
  };

  const removeAll = async () => {
    const ok = await confirm({
      title: "Delete your whole timeline?",
      message: "All of your location history is deleted for good. This can't be undone.",
      confirmLabel: "Delete everything",
      danger: true,
    });
    if (!ok) return;
    await apiClient.delete("/maps/timeline", { params: { everything: true } });
    shown.current = null;
    void qc.invalidateQueries({ queryKey: ["maps-timeline"] });
  };

  return (
    <div className="pb-4">
      <div className="flex items-center gap-2 px-3 pt-3">
        <button type="button" onClick={onClose} aria-label="Back" className="rounded-full p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="flex-1 text-base font-semibold text-[var(--text)]">Your timeline</h1>
      </div>

      <div className="flex items-center justify-between px-3 pt-2">
        <button type="button" onClick={() => setDay(shift(day, -1))} aria-label="The day before" className="rounded-full p-2 text-[var(--text)] hover:bg-[var(--hover)]"><ChevronLeft className="h-4 w-4" /></button>
        <label className="text-sm font-medium text-[var(--text)]">
          <span className="sr-only">Day</span>
          <input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} className="bg-transparent text-center outline-none" />
        </label>
        <button type="button" onClick={() => setDay(shift(day, 1))} disabled={day >= today} aria-label="The day after" className="rounded-full p-2 text-[var(--text)] enabled:hover:bg-[var(--hover)] disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
      </div>

      {isLoading && <RowsSkeleton rows={4} label="Loading this day" />}
      {error && <p className="px-4 py-3 text-sm text-[var(--text-muted)]">{apiErrorMessage(error, "Couldn't load this day.")}</p>}
      {data && data.segments.length === 0 && <p className="px-4 py-4 text-center text-sm text-[var(--text-muted)]">Nothing recorded on this day.</p>}
      {data && data.segments.length > 0 && (
        <>
          <ol className="px-4 pt-2">
            {data.segments.map((s) => {
              const Icon = s.type === "stay" ? MapPin : MODE[s.mode ?? "drive"];
              return (
                <li key={s.start} className="flex gap-3 border-l-2 border-[var(--border)] pb-3 pl-3 last:pb-0">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-[var(--text)]">{s.type === "stay" ? s.name : `${MODE_LABEL[s.mode ?? "drive"]}, ${formatKm(s.km ?? 0)}`}</p>
                    <p className="text-xs text-[var(--text-muted)]">{clock(s.start)} – {clock(s.end)} · {lasted(s)}</p>
                  </div>
                </li>
              );
            })}
          </ol>
          {data.km > 0 && <p className="px-4 pt-2 text-xs text-[var(--text-muted)]">{formatKm(data.km)} travelled</p>}
        </>
      )}
      {data && data.photos.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto px-4 pt-3">
          {data.photos.map((p) => (
            <img key={p.id} src={p.thumb} alt="A photo from this day" loading="lazy" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
          ))}
        </div>
      )}
      {data && data.points > 0 && (
        <div className="px-4 pt-3">
          <button type="button" onClick={removeDay} className="inline-flex min-h-10 items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)] md:min-h-0"><Trash2 className="h-3.5 w-3.5" />Delete this day</button>
        </div>
      )}

      <div className="mt-4 space-y-3 border-t border-[var(--border)] px-4 pt-3">
        <SwitchRow checked={settings?.timeline_on ?? false} onChange={(on) => void setRecording(on)}>
          <span className="text-sm text-[var(--text)]">Record where I go</span>
        </SwitchRow>
        <p className="text-xs text-[var(--text-muted)]">Only you can see your timeline. An admin of this server could read its database.</p>
        <div>
          <p className="mb-1 text-sm text-[var(--text)]">Keep history for</p>
          <Choice
            label="Keep history for"
            value={settings?.retention_days ?? 0}
            onChange={(days) => void setRetention(days)}
            options={[
              { value: 30, label: "30 days" },
              { value: 90, label: "3 months" },
              { value: 365, label: "1 year" },
              { value: 1095, label: "3 years" },
              { value: 0, label: "Until I delete it" },
            ]}
          />
        </div>
        <GoogleImport onDone={() => void qc.invalidateQueries({ queryKey: ["maps-timeline"] })} />
        <button type="button" onClick={removeAll} className="inline-flex min-h-10 items-center gap-1.5 text-xs text-[var(--danger,#c0392b)] hover:underline md:min-h-0"><Trash2 className="h-3.5 w-3.5" />Delete my whole timeline</button>
      </div>
    </div>
  );
}

function GoogleImport({ onDone }: { onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const run = async (file: File) => {
    try {
      setProgress("Reading the file…");
      const points = pointsFromExport(JSON.parse(await file.text()));
      if (!points.length) {
        toast.error("No locations found in that file.");
        return;
      }
      let saved = 0;
      for (let i = 0; i < points.length; i += 2000) {
        const r = await apiClient.post<{ saved: number }>("/maps/timeline/points", { points: points.slice(i, i + 2000), source: "google" });
        saved += r.data.saved;
        setProgress(`Importing… ${Math.min(100, Math.round(((i + 2000) / points.length) * 100))}%`);
      }
      toast.success(`Imported ${saved.toLocaleString()} locations.`);
      onDone();
    } catch (e) {
      toast.error(e instanceof SyntaxError ? "That file isn't a Google Timeline export." : apiErrorMessage(e, "The import stopped."));
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div>
      <input ref={input} type="file" accept=".json,application/json" className="hidden" aria-label="Google Timeline file" onChange={(e) => e.target.files?.[0] && void run(e.target.files[0])} />
      <button type="button" disabled={!!progress} onClick={() => input.current?.click()} className="inline-flex items-center gap-1.5 text-sm text-[var(--text)] hover:underline disabled:opacity-60">
        {progress ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {progress ?? "Import from Google Timeline"}
      </button>
      {!progress && <p className="mt-0.5 text-xs text-[var(--text-muted)]">Export Timeline.json on your phone (Google Maps → Your Timeline → Export) or Records.json from Takeout. It's read here, then only the locations are saved to this server.</p>}
    </div>
  );
}
