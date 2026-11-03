import { useState } from "react";

import { authApi } from "@/api/auth";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { useCanUseAutomations } from "@/hooks/useCanUseAutomations";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";

import { OPTIONAL_NAV_KEYS, type OptionalNavKey } from "./navItems";

/** The bigger optional surfaces a new member starts without. */
const CHOOSABLE: OptionalNavKey[] = ["places", "workspaces", "tasks"];

/** First sign-in: pick which of the optional apps go in your sidebar.
 *  New members start with them hidden; this asks once, then the same
 *  switches live in Account → Sidebar features. Admins set the instance
 *  up themselves, so they're never asked. */
export function WelcomeAppsDialog() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const canAutomate = useCanUseAutomations();
  const hidden = user?.settings?.hidden_nav ?? [];
  const keys = CHOOSABLE.filter((k) => k !== "tasks" || canAutomate);
  const [on, setOn] = useState<Set<OptionalNavKey>>(() => new Set(keys.filter((k) => !hidden.includes(k))));
  const [saving, setSaving] = useState(false);

  const ask =
    !!user && user.role !== "admin" && !user.must_change_password && !user.settings?.features_chosen;
  if (!ask) return null;

  const finish = async (apply: boolean) => {
    setSaving(true);
    const next = apply
      ? [...hidden.filter((k) => !keys.includes(k as OptionalNavKey)), ...keys.filter((k) => !on.has(k))]
      : hidden;
    try {
      setUser(await authApi.updatePreferences({ hidden_nav: next, features_chosen: true }));
    } catch {
      toast.error("Couldn't save that — you can change it later in Account → Sidebar features.");
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => void finish(false)}
      title="Pick your apps"
      description="Chat, Files, Photos and Today are always there. Turn on the extras you want — you can change this any time in Account → Sidebar features."
      widthClass="max-w-md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => void finish(false)} disabled={saving}>
            Not now
          </Button>
          <Button variant="primary" size="sm" onClick={() => void finish(true)} disabled={saving}>
            Done
          </Button>
        </>
      }
    >
      <ul className="space-y-1">
        {keys.map((k) => {
          const meta = OPTIONAL_NAV_KEYS.find((x) => x.key === k)!;
          return (
            <li key={k}>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-[var(--hover)]">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={on.has(k)}
                  onChange={() =>
                    setOn((prev) => {
                      const n = new Set(prev);
                      if (n.has(k)) n.delete(k);
                      else n.add(k);
                      return n;
                    })
                  }
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-[var(--text)]">{meta.label}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{meta.description}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
