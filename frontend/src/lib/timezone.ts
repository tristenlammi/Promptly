import { authApi } from "@/api/auth";
import { useAuthStore } from "@/store/authStore";

let tried = false;

/** Save this browser's time zone for someone who has none yet (once per
 *  page load) — the chat's sense of "now" and the days in Photos use it. */
export async function adoptBrowserTimezone(): Promise<void> {
  if (tried) return;
  tried = true;
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return;
  }
  if (!zone) return;
  try {
    const user = await authApi.updatePreferences({ timezone: zone });
    useAuthStore.getState().setUser(user);
  } catch {
    // Not important enough to bother anyone about; next load tries again.
  }
}
