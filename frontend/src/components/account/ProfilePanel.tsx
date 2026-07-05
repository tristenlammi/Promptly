import { useRef, useState } from "react";
import { Check, Loader2, Trash2, Upload, UserRound } from "lucide-react";

import { authApi } from "@/api/auth";
import { useAuthStore } from "@/store/authStore";
import {
  UserAvatar,
  defaultColorForUserId,
} from "@/components/shared/UserAvatar";
import { cn } from "@/utils/cn";

/**
 * Profile appearance: picture + initials-chip colour.
 *
 * The picture is server-processed (square crop, 256px, WEBP) so any
 * reasonable upload works. The colour swatches are the collab-cursor
 * palette — picking one recolours the user's chip *and* their live
 * cursor everywhere; "Auto" clears back to the deterministic per-user
 * hash the app has always used.
 */
const SWATCHES = [
  "#D97757",
  "#4F46E5",
  "#0EA5E9",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#A855F7",
  "#14B8A6",
];

export function ProfilePanel() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | "color" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const autoColor = defaultColorForUserId(user?.id);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setBusy("upload");
    try {
      setUser(await authApi.uploadAvatar(file));
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't upload that image. Try a different one."
      );
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async () => {
    setError(null);
    setBusy("remove");
    try {
      setUser(await authApi.deleteAvatar());
    } catch {
      setError("Couldn't remove the picture. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const onColor = async (color: string | null) => {
    setError(null);
    setBusy("color");
    try {
      setUser(await authApi.updateProfile({ avatar_color: color }));
    } catch {
      setError("Couldn't save the colour. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">
            <UserRound className="h-4 w-4" />
          </span>
          <h3 className="text-sm font-semibold">Profile</h3>
        </div>
        {busy && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving
          </span>
        )}
      </header>

      <div className="space-y-5 px-4 py-4">
        {/* Picture */}
        <div className="flex items-center gap-4">
          <UserAvatar
            name={user?.username ?? "?"}
            userId={user?.id}
            avatarUrl={user?.avatar_url}
            color={user?.avatar_color}
            size={64}
            initialsCount={2}
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-[var(--text)]">
              {user?.username}
            </div>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Shown on comments, boards, member lists, and live cursors.
              PNG/JPEG/WEBP/GIF up to 5 MB — it's cropped square for you.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                {user?.avatar_url ? "Replace picture" : "Upload picture"}
              </button>
              {user?.avatar_url && (
                <button
                  type="button"
                  onClick={() => void onRemove()}
                  disabled={busy !== null}
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--danger)] disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </button>
              )}
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => void onPick(e)}
          />
        </div>

        {/* Colour */}
        <div>
          <div className="mb-1.5 text-xs font-medium text-[var(--text)]">
            Initials colour
          </div>
          <p className="mb-2 text-xs text-[var(--text-muted)]">
            Used for your initials chip and your live cursor in shared notes
            and canvases.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/* Auto = the stable per-user palette colour. */}
            <button
              type="button"
              onClick={() => void onColor(null)}
              disabled={busy !== null}
              title={`Auto (${autoColor})`}
              className={cn(
                "relative inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition disabled:opacity-50",
                !user?.avatar_color
                  ? "border-[var(--accent)] text-[var(--text)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]"
              )}
            >
              <span
                className="h-3.5 w-3.5 rounded-full"
                style={{ backgroundColor: autoColor }}
              />
              Auto
            </button>
            {SWATCHES.map((c) => {
              const selected = user?.avatar_color === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => void onColor(c)}
                  disabled={busy !== null}
                  title={c}
                  style={{ backgroundColor: c }}
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded-full transition disabled:opacity-50",
                    selected
                      ? "ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--surface)]"
                      : "hover:scale-110"
                  )}
                >
                  {selected && <Check className="h-3.5 w-3.5 text-white" />}
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <p className="text-xs text-[var(--danger)]" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
