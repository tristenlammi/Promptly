import { Stethoscope } from "lucide-react";
import { useEffect, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Sheet } from "@/items/ui";

import { LogSheet } from "./LogSheet";
import { allMetrics } from "./metrics";
import { SymptomSheet } from "./sheets";
import type { HealthData } from "./types";

/*
 * "Log something": a picker of every metric (and symptoms), then the right
 * sheet. Opened by the header's quick action (which also switches to
 * Today via ``goTo``), the phone FAB, or a tile. Requests go through a tiny
 * module-level store (no window events): a request made before a host has
 * mounted — e.g. right as the tab switches — is picked up when it mounts.
 */

type Request = { metric: string | null; n: number };
let pending: Request | null = null;
let counter = 0;
const listeners = new Set<() => void>();

export function openQuickLog(metric?: string) {
  pending = { metric: metric ?? null, n: ++counter };
  // After the current event: a tab switch made in the same click has
  // committed by then, so the host that opens the sheet is the one that stays.
  window.setTimeout(() => {
    for (const l of [...listeners]) l();
  }, 0);
}

export function QuickLogHost({ item }: { item: ItemHandle<HealthData> }) {
  const [picker, setPicker] = useState(false);
  const [metric, setMetric] = useState<string | null>(null);
  const [symptom, setSymptom] = useState(false);

  useEffect(() => {
    const take = () => {
      const req = pending;
      if (!req) return;
      pending = null;
      if (req.metric === "symptom") setSymptom(true);
      else if (req.metric) setMetric(req.metric);
      else setPicker(true);
    };
    listeners.add(take);
    take();
    return () => {
      listeners.delete(take);
    };
  }, []);

  if (!item.canEdit) return null;
  const metrics = allMetrics(item.data);
  return (
    <>
      <Sheet open={picker} onClose={() => setPicker(false)} title="Log">
        <div className="grid grid-cols-3 gap-2 pb-2 sm:grid-cols-4">
          {metrics.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setPicker(false);
                setMetric(m.id);
              }}
              className="flex h-20 flex-col items-center justify-center gap-1.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-1 text-xs font-medium text-[var(--text)] transition hover:bg-[var(--hover)] active:scale-95"
            >
              <m.icon className="h-5 w-5 text-[var(--item-accent)]" />
              <span className="line-clamp-2 text-center leading-tight">{m.label}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setPicker(false);
              setSymptom(true);
            }}
            className="flex h-20 flex-col items-center justify-center gap-1.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-xs font-medium text-[var(--text)] transition hover:bg-[var(--hover)] active:scale-95"
          >
            <Stethoscope className="h-5 w-5 text-[var(--item-accent)]" />
            Symptom
          </button>
        </div>
      </Sheet>
      {metric && <LogSheet item={item} metric={metric} onClose={() => setMetric(null)} />}
      {symptom && <SymptomSheet item={item} onClose={() => setSymptom(false)} />}
    </>
  );
}
