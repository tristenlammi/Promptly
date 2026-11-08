/**
 * Per-person volume (0–200%), "Mute for me", the output volume and the Go
 * Live stream's own volume, turned into the gain each remote track plays
 * at. Per-person choices live in ``user.settings`` (``voice_volumes``
 * {user id: percent}, ``voice_local_mutes`` [user id]) so they follow you
 * to every device.
 */

export const DEFAULT_PERCENT = 100;
export const MAX_PERCENT = 200;

export interface VolumePrefs {
  /** {user id: 0..200}; missing = 100. */
  volumes: Record<string, number>;
  /** People muted for you only. */
  localMutes: readonly string[];
  /** Output volume, 0..200. */
  output: number;
}

export function clampPercent(pct: number): number {
  if (!Number.isFinite(pct)) return DEFAULT_PERCENT;
  return Math.max(0, Math.min(MAX_PERCENT, Math.round(pct)));
}

/** The percent someone plays at for you (before the output volume). */
export function personPercent(userId: string, prefs: Pick<VolumePrefs, "volumes">): number {
  const v = prefs.volumes[userId];
  return v === undefined ? DEFAULT_PERCENT : clampPercent(v);
}

/** The linear gain someone's voice plays at (0 when muted for you). */
export function personGain(userId: string, prefs: VolumePrefs): number {
  if (prefs.localMutes.includes(userId)) return 0;
  return (personPercent(userId, prefs) / 100) * (clampPercent(prefs.output) / 100);
}

/** The linear gain a watched stream's sound plays at. */
export function streamGain(streamPercent: number, outputPercent: number): number {
  return (clampPercent(streamPercent) / 100) * (clampPercent(outputPercent) / 100);
}

/** A new volumes map with someone set (100% is the default, so it's left out
 *  to keep the stored map small). */
export function withVolume(volumes: Record<string, number>, userId: string, pct: number): Record<string, number> {
  const next = { ...volumes };
  const v = clampPercent(pct);
  if (v === DEFAULT_PERCENT) delete next[userId];
  else next[userId] = v;
  return next;
}

/** A new "muted for me" list with someone added or removed. */
export function withLocalMute(list: readonly string[], userId: string, muted: boolean): string[] {
  const rest = list.filter((id) => id !== userId);
  return muted ? [...rest, userId] : rest;
}
