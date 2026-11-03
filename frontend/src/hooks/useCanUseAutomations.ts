import { useAuthStore } from "@/store/authStore";

/** Automations are off unless an admin turns them on for the account
 *  (admins always have them). The server re-checks every call. */
export function useCanUseAutomations(): boolean {
  return useAuthStore((s) => s.user?.role === "admin" || s.user?.can_use_automations === true);
}
