import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { albumsApi, type SmartRules } from "@/api/albums";
import { peopleApi } from "@/api/people";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/** A smart album's question (PH-5): who, which pets, where, when, what it
 *  shows — with a live count and the newest few, so you see what it holds
 *  before saving. New photos that match join it from then on. */
export function SmartAlbumDialog({
  initial,
  title: initialTitle = "",
  onClose,
  onSave,
}: {
  initial?: SmartRules | null;
  title?: string;
  onClose: () => void;
  /** Save the title and question; resolves when done. */
  onSave: (title: string, rules: SmartRules) => Promise<void>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [rules, setRules] = useState<SmartRules>(() => ({ people: [], pets: [], ...(initial ?? {}) }));
  const [saving, setSaving] = useState(false);
  const { data: people } = useQuery({ queryKey: ["people", "person", false], queryFn: () => peopleApi.list("person") });
  const { data: pets } = useQuery({ queryKey: ["people", "pet", false], queryFn: () => peopleApi.list("pet") });
  const set = (patch: Partial<SmartRules>) => setRules((r) => ({ ...r, ...patch }));

  // The preview follows the question, a moment after typing stops.
  const [asked, setAsked] = useState(rules);
  useEffect(() => {
    const t = window.setTimeout(() => setAsked(rules), 500);
    return () => window.clearTimeout(t);
  }, [rules]);
  const empty = useMemo(
    () => !(asked.people?.length || asked.pets?.length || asked.place || asked.date_from || asked.date_to || asked.looks_like || asked.text || asked.media || asked.favorites),
    [asked],
  );
  const preview = useQuery({
    queryKey: ["album-preview", asked],
    queryFn: () => albumsApi.preview(asked),
    enabled: !empty,
    retry: false,
  });

  const chosenPeople = new Set(rules.people ?? []);
  const chosenPets = new Set(rules.pets ?? []);
  const toggle = (key: "people" | "pets", value: string) =>
    set({ [key]: (rules[key] ?? []).includes(value) ? (rules[key] ?? []).filter((x) => x !== value) : [...(rules[key] ?? []), value] });
  const me = (people ?? []).find((p) => p.me);
  const input = "w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm";

  return (
    <Modal open onClose={onClose} title="Smart album" widthClass="max-w-xl">
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="text-xs font-medium text-[var(--text-muted)]">Name</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Max at the beach" className={input} aria-label="Album name" />
        </label>
        {(people?.length ?? 0) > 0 && (
          <fieldset>
            <legend className="text-xs font-medium text-[var(--text-muted)]">With (all of them)</legend>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {me && <Chip on={chosenPeople.has("me")} onClick={() => toggle("people", "me")}>Me</Chip>}
              {(people ?? []).filter((p) => p.name && !p.me).map((p) => (
                <Chip key={p.id} on={chosenPeople.has(`id:${p.id}`)} onClick={() => toggle("people", `id:${p.id}`)}>{p.name}</Chip>
              ))}
            </div>
          </fieldset>
        )}
        {(pets?.length ?? 0) > 0 && (
          <fieldset>
            <legend className="text-xs font-medium text-[var(--text-muted)]">Pets</legend>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {(pets ?? []).filter((p) => p.name).map((p) => (
                <Chip key={p.id} on={chosenPets.has(`id:${p.id}`)} onClick={() => toggle("pets", `id:${p.id}`)}>{p.name}</Chip>
              ))}
            </div>
          </fieldset>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs font-medium text-[var(--text-muted)]">Where</span>
            <input value={rules.place ?? ""} onChange={(e) => set({ place: e.target.value || null })} placeholder="Noosa, Japan…" className={input} aria-label="Where" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-[var(--text-muted)]">Shows</span>
            <input value={rules.looks_like ?? ""} onChange={(e) => set({ looks_like: e.target.value || null })} placeholder="on the beach" className={input} aria-label="Shows" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-[var(--text-muted)]">From</span>
            <input type="date" value={rules.date_from ?? ""} onChange={(e) => set({ date_from: e.target.value || null })} className={input} aria-label="From" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-[var(--text-muted)]">To</span>
            <input type="date" value={rules.date_to ?? ""} onChange={(e) => set({ date_to: e.target.value || null })} className={input} aria-label="To" />
          </label>
          <label className="col-span-2 block">
            <span className="text-xs font-medium text-[var(--text-muted)]">Words written in it</span>
            <input value={rules.text ?? ""} onChange={(e) => set({ text: e.target.value || null })} placeholder="a sign, a menu…" className={input} aria-label="Words written in it" />
          </label>
        </div>
        <div className="flex gap-4 text-xs">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={rules.media === "video"} onChange={(e) => set({ media: e.target.checked ? "video" : null })} /> Videos only</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!rules.favorites} onChange={(e) => set({ favorites: e.target.checked })} /> Favourites only</label>
        </div>
        <div aria-label="Preview" className="rounded-md bg-[var(--hover)] p-2 text-xs">
          {empty ? (
            <span className="text-[var(--text-muted)]">Choose who, where, when or what — the photos that match show here.</span>
          ) : preview.isFetching && !preview.data ? (
            <span className="text-[var(--text-muted)]">Looking…</span>
          ) : preview.error ? (
            <span className="text-amber-600 dark:text-amber-400">{apiErrorMessage(preview.error, "That can't be looked for.")}</span>
          ) : preview.data ? (
            <>
              <p className="mb-1.5 font-medium">{preview.data.count.toLocaleString()} {preview.data.count === 1 ? "photo" : "photos"} now · {preview.data.summary}</p>
              <div className="flex gap-1 overflow-hidden">
                {preview.data.sample.map((p) => (
                  p.thumb ? <img key={p.id} src={p.thumb} alt="" className="h-12 w-12 rounded object-cover" /> : <span key={p.id} className="h-12 w-12 rounded bg-[var(--surface)]" />
                ))}
              </div>
            </>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            variant="primary"
            loading={saving}
            disabled={empty || !title.trim() || !!preview.error}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(title.trim(), rules);
              } finally {
                setSaving(false);
              }
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={cn("rounded-full border px-2.5 py-0.5 text-xs", on ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]" : "border-[var(--border)] hover:bg-[var(--hover)]")}>
      {children}
    </button>
  );
}
