import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { authApi } from "@/api/auth";
import { extractError } from "@/components/files/helpers";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";

import { itemsApi } from "./api";

/** An app that can sit in the sidebar: a built-in one or an added Item Store app. */
export interface NavApp {
  id: string;
  name: string;
  icon: string;
  to: string;
}

/** Apps that are part of Promptly itself (not file-backed items). */
export const BUILT_IN_APPS: NavApp[] = [
  { id: "rooms", name: "Rooms", icon: "/item-icons/rooms-192.png", to: "/rooms" },
  { id: "calendar", name: "Calendar", icon: "/item-icons/calendar-192.png", to: "/calendar" },
];

/**
 * The apps this person pinned to their sidebar (``settings.nav_apps``) —
 * so an app can be used from inside Promptly without installing it.
 * ``apps`` resolves them in pinned order, skipping any they've since removed.
 */
export function useNavApps() {
  const pinnedIds = useAuthStore((s) => s.user?.settings?.nav_apps);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);
  const [saving, setSaving] = useState(false);
  const pinned = useMemo(() => pinnedIds ?? [], [pinnedIds]);
  const { data: launcher } = useQuery({
    queryKey: ["apps-launcher"],
    queryFn: itemsApi.launcher,
    enabled: pinned.length > 0,
    staleTime: 60_000,
  });

  const apps = useMemo(() => {
    const all = new Map<string, NavApp>(BUILT_IN_APPS.map((a) => [a.id, a]));
    for (const a of launcher ?? []) {
      all.set(a.kind, { id: a.kind, name: a.name, icon: `/item-icons/${a.kind}-192.png`, to: `/apps/${a.kind}` });
    }
    return pinned.map((id) => all.get(id)).filter((a): a is NavApp => Boolean(a));
  }, [pinned, launcher]);

  const toggle = async (id: string) => {
    const previous = pinned;
    const next = previous.includes(id) ? previous.filter((k) => k !== id) : [...previous, id];
    patchSettings({ nav_apps: next });
    setSaving(true);
    try {
      setUser(await authApi.updatePreferences({ nav_apps: next }));
    } catch (err) {
      patchSettings({ nav_apps: previous });
      toast.error(extractError(err));
    } finally {
      setSaving(false);
    }
  };

  return { pinned, apps, toggle, saving };
}
