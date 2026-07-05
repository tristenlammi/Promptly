import { useState } from "react";

import { cn } from "@/utils/cn";

/**
 * The one avatar renderer — profile picture when the user set one,
 * otherwise an initials chip on their colour.
 *
 * Colour resolution matches the backend exactly: the user's chosen
 * ``avatar_color`` wins, else a deterministic palette hash of their
 * user id — the same palette + ``uuid.int % 8`` the collab-cursor
 * colours use, so a person's chip matches their cursor everywhere.
 */

// Keep in sync with AVATAR_COLOR_PALETTE (backend/app/auth/avatars.py).
const PALETTE = [
  "#D97757",
  "#4F46E5",
  "#0EA5E9",
  "#10B981",
  "#F59E0B",
  "#EF4444",
  "#A855F7",
  "#14B8A6",
];

/** Mirror of the backend's ``uuid.int % len(palette)``. The UUID's int
 *  value mod 8 only depends on its last hex digit's low bits, so parsing
 *  one character reproduces the hash without BigInt gymnastics. */
export function defaultColorForUserId(userId: string | null | undefined): string {
  if (!userId) return PALETTE[0];
  const hex = userId.replace(/-/g, "");
  const last = parseInt(hex[hex.length - 1] ?? "0", 16);
  if (Number.isNaN(last)) return PALETTE[0];
  return PALETTE[last % PALETTE.length];
}

export function UserAvatar({
  name,
  userId,
  avatarUrl,
  color,
  size = 24,
  initialsCount = 1,
  title,
  className,
}: {
  name: string;
  /** Drives the deterministic fallback colour; omit to use the accent. */
  userId?: string | null;
  avatarUrl?: string | null;
  /** Explicit chip colour (the user's ``avatar_color``); overrides the hash. */
  color?: string | null;
  size?: number;
  /** 1 for dense chips ("T"), 2 for the roomier account chip ("TR"). */
  initialsCount?: 1 | 2;
  title?: string;
  className?: string;
}) {
  // A broken/expired image URL falls back to the initials chip rather
  // than the browser's broken-image glyph.
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(avatarUrl) && !failed;
  const chipColor = color || defaultColorForUserId(userId);
  const initials = (name || "?").slice(0, initialsCount).toUpperCase();

  if (showImage) {
    return (
      <img
        src={avatarUrl as string}
        alt={name}
        title={title ?? name}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className={cn(
          "shrink-0 rounded-full object-cover",
          className
        )}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      title={title ?? name}
      style={{
        width: size,
        height: size,
        backgroundColor: chipColor,
        fontSize: Math.max(9, size * 0.45),
      }}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold uppercase text-white",
        className
      )}
    >
      {initials}
    </span>
  );
}
