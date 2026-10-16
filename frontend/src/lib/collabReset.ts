import { toast } from "@/store/toastStore";

/**
 * After a version restore (WP-6.2) an editor still holding the replaced
 * state must not reconnect and merge it back in — it reloads onto the
 * restored file instead. Triggered by the collab room's "reset" ping, or by
 * a token / save that shows the file's edit generation (``epoch``) moved on.
 */
let reloading = false;

export function reloadForRestore(message = "This file was restored to an earlier version — reloading…"): void {
  if (reloading) return;
  reloading = true;
  toast.info(message);
  window.setTimeout(() => window.location.reload(), 900);
}

/** A stateless payload from the collab room that means "reset". */
export function isResetPing(payload: string): boolean {
  try {
    return JSON.parse(payload)?.type === "reset";
  } catch {
    return false;
  }
}

/** Track the generation an editor loaded; reload when a newer one shows up. */
export function epochWatcher() {
  let loaded: number | null = null;
  return {
    seen(epoch: number | undefined | null): void {
      const e = typeof epoch === "number" ? epoch : 0;
      if (loaded === null) loaded = e;
      else if (e !== loaded) reloadForRestore();
    },
    get loaded(): number | null {
      return loaded;
    },
  };
}
