import { Check, Image as ImageIcon, ImagePlus, Images, Loader2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { photosApi, type PhotoItem } from "@/api/photos";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { MenuItem, Pop } from "./Pop";
import { Sheet } from "./Sheet";

/**
 * "Add image": a picture from this device (the camera, on a phone) or one
 * from your Photos library. A library photo is referenced, not copied.
 */
export function AddImageButton({
  onFiles,
  onPhotos,
  className,
  iconClassName = "h-[18px] w-[18px]",
  label = "Add image",
}: {
  onFiles: (files: File[]) => void;
  onPhotos: (photos: PhotoItem[]) => void;
  className?: string;
  iconClassName?: string;
  label?: string;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  return (
    <>
      <button ref={btn} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} className={className}>
        <ImagePlus className={iconClassName} />
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="Choose pictures"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
      {menu && (
        <Pop anchor={btn.current} label={label} role="menu" onClose={() => setMenu(false)} width={230}>
          <MenuItem
            icon={Upload}
            onClick={() => {
              setMenu(false);
              input.current?.click();
            }}
          >
            From this device
          </MenuItem>
          <MenuItem
            icon={Images}
            onClick={() => {
              setMenu(false);
              setPicker(true);
            }}
          >
            From Photos
          </MenuItem>
        </Pop>
      )}
      {picker && (
        <PhotosPicker
          onClose={() => setPicker(false)}
          onPick={(items) => {
            setPicker(false);
            onPhotos(items);
          }}
        />
      )}
    </>
  );
}

const MAX_PICK = 20;

/** Pick pictures from your Photos library (yours only: a photo someone shared
 *  with you would show to everyone on the note). */
export function PhotosPicker({ onClose, onPick }: { onClose: () => void; onPick: (items: PhotoItem[]) => void }) {
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);

  const load = async (before: string | null | undefined) => {
    setLoading(true);
    setError(null);
    try {
      const page = await photosApi.timeline({ view: "all", before: before ?? undefined, limit: 120 });
      setItems((cur) => [...cur, ...page.items.filter((p) => p.kind === "image" && p.mine !== false)]);
      setCursor(page.next_cursor);
    } catch (e) {
      setError(typeof navigator !== "undefined" && navigator.onLine === false ? "Connect to the internet to choose from Photos." : apiErrorMessage(e, "Couldn't load your photos."));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= MAX_PICK ? c : [...c, id]));
  const picked = chosen.map((id) => items.find((p) => p.id === id)).filter((p): p is PhotoItem => !!p);

  return (
    <Sheet
      title="Add from Photos"
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto text-sm text-[var(--text-muted)]">{chosen.length ? `${chosen.length} selected` : "Choose pictures"}</span>
          <button type="button" onClick={onClose} className="h-9 rounded-full px-4 text-sm font-medium hover:bg-[var(--hover)]">
            Cancel
          </button>
          <button type="button" disabled={!chosen.length} onClick={() => onPick(picked)} className="h-9 rounded-full bg-[var(--accent-strong)] px-4 text-sm font-medium text-white disabled:opacity-50">
            Add{chosen.length ? ` ${chosen.length}` : ""}
          </button>
        </>
      }
    >
      {error ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p className="text-sm text-[var(--text)]" role="alert">
            {error}
          </p>
          <button type="button" onClick={() => void load(cursor)} className="rounded-full px-3 py-1.5 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--hover)]">
            Try again
          </button>
        </div>
      ) : !items.length && !loading ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <ImageIcon className="h-10 w-10 text-[var(--text-muted)] opacity-50" aria-hidden />
          <p className="font-medium">No pictures in your Photos yet</p>
          <p className="text-sm text-[var(--text-muted)]">Pictures you back up or upload to Photos show here.</p>
        </div>
      ) : (
        <>
          <ul className="grid grid-cols-3 gap-1 sm:grid-cols-5" aria-label="Your photos">
            {items.map((p) => {
              const on = chosen.includes(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    aria-label={`${on ? "Unselect" : "Select"} ${p.filename}`}
                    onClick={() => toggle(p.id)}
                    className={cn("relative block aspect-square w-full overflow-hidden rounded-md bg-[var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]", on && "ring-[3px] ring-[var(--accent)]")}
                  >
                    {p.thumb ? <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-cover" /> : <ImageIcon className="m-auto h-6 w-6 text-[var(--text-muted)]" aria-hidden />}
                    <span className={cn("absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white shadow", on ? "bg-[var(--accent-strong)]" : "bg-black/25")} aria-hidden>
                      {on && <Check className="h-3.5 w-3.5 text-white" />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {loading && (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-[var(--text-muted)]" role="status">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading your photos…
            </p>
          )}
          {!loading && cursor && (
            <div className="flex justify-center pt-3">
              <button type="button" onClick={() => void load(cursor)} className="rounded-full px-4 py-2 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--hover)]">
                Show more
              </button>
            </div>
          )}
          {chosen.length >= MAX_PICK && <p className="pt-2 text-center text-xs text-[var(--text-muted)]">You can add {MAX_PICK} at a time.</p>}
        </>
      )}
    </Sheet>
  );
}
