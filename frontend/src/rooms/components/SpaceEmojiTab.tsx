/**
 * Space settings → Emoji: the space's own emoji. Everyone in the space can
 * see and use them (``:name:`` in a message, or as a reaction); its owner
 * and admins add, rename and delete them.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Check, ImagePlus, Loader2, Pencil, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";

import { roomsApi, type Space, type SpaceEmoji } from "@/api/rooms";
import { TextInput } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { BOOTSTRAP_KEY } from "../cache";
import { askInSheet } from "./ConfirmSheet";

/** ``Party Time.png`` → ``party_time``. */
function nameFromFile(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
}

const NAME_OK = /^[a-z0-9_]{2,30}$/;
const iconBtn =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50";

export function SpaceEmojiTab({ space }: { space: Space }) {
  const qc = useQueryClient();
  const isAdmin = space.role === "owner" || space.role === "admin";
  const emojis = space.emojis ?? [];
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const refresh = () => qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
  const clean = (v: string) => v.toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 30);

  const choose = (f: File | null) => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
    if (f && !name) setName(nameFromFile(f.name));
  };

  const add = async () => {
    if (!file || !NAME_OK.test(name) || busy) return;
    setBusy(true);
    try {
      await roomsApi.addEmoji(space.id, name, file);
      await refresh();
      toast.success(`:${name}: added`);
      choose(null);
      setName("");
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't add that emoji."));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (e: SpaceEmoji) => {
    const next = clean(editName);
    if (!NAME_OK.test(next) || next === e.name) {
      setEditing(null);
      return;
    }
    try {
      await roomsApi.renameEmoji(e.id, next);
      await refresh();
      setEditing(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't rename that emoji."));
    }
  };

  const del = async (e: SpaceEmoji) => {
    const ok = await askInSheet({
      title: `Delete :${e.name}:?`,
      message: "Messages and reactions that used it will show its name as plain text.",
      confirmLabel: "Delete emoji",
      danger: true,
    });
    if (!ok) return;
    try {
      await roomsApi.deleteEmoji(e.id);
      await refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't delete that emoji."));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--text-muted)]">
        {space.name}'s own emoji. Type <code className="rounded bg-[var(--surface-2)] px-1 py-0.5 font-mono text-[0.85em]">:name:</code> in a message, or pick one from the emoji
        button. {isAdmin ? "Everyone in the space can use them." : "The space's admins add them."}
      </p>

      {isAdmin && (
        <div className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              aria-label={file ? "Choose a different picture" : "Choose a picture"}
              className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {preview ? <img src={preview} alt="" className="h-full w-full object-contain" /> : <ImagePlus className="h-5 w-5" />}
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={(e) => {
                choose(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-xs font-medium text-[var(--text-muted)]">Name</span>
              <TextInput
                value={name}
                maxLength={30}
                placeholder="party"
                onChange={(e) => setName(clean(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void add();
                  }
                }}
              />
            </label>
            <button
              type="button"
              onClick={() => void add()}
              disabled={!file || !NAME_OK.test(name) || busy}
              className="mt-5 inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Add
            </button>
          </div>
          <p className="text-xs text-[var(--text-muted)]">A small square PNG, JPEG, GIF or WebP works best. Names are 2 to 30 letters, numbers or underscores.</p>
        </div>
      )}

      {emojis.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
          {isAdmin ? "No emoji yet. Choose a picture above to add the first." : "This space has no emoji of its own yet."}
        </p>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          {emojis.map((e) => (
            <li key={e.id} className="flex min-h-[52px] items-center gap-3 border-b border-[var(--border)] px-3 py-1.5 last:border-b-0">
              <img src={e.url} alt="" className="h-8 w-8 shrink-0 object-contain" />
              {editing === e.id ? (
                <>
                  <TextInput
                    className="min-w-0 flex-1"
                    value={editName}
                    maxLength={30}
                    autoFocus
                    aria-label={`New name for ${e.name}`}
                    onChange={(ev) => setEditName(clean(ev.target.value))}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter") {
                        ev.preventDefault();
                        void rename(e);
                      } else if (ev.key === "Escape") {
                        ev.stopPropagation();
                        setEditing(null);
                      }
                    }}
                  />
                  <button type="button" aria-label="Save name" onClick={() => void rename(e)} className={iconBtn}>
                    <Check className="h-4 w-4" />
                  </button>
                  <button type="button" aria-label="Cancel" onClick={() => setEditing(null)} className={iconBtn}>
                    <X className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-[var(--text)]">:{e.name}:</span>
                  {isAdmin && (
                    <>
                      <button
                        type="button"
                        aria-label={`Rename ${e.name}`}
                        onClick={() => {
                          setEditing(e.id);
                          setEditName(e.name);
                        }}
                        className={iconBtn}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button type="button" aria-label={`Delete ${e.name}`} onClick={() => void del(e)} className={`${iconBtn} hover:!text-[var(--danger)]`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
