import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";

import { authApi } from "@/api/auth";
import { extractError } from "@/components/files/helpers";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";

import { itemsApi } from "./api";
import { BUILT_IN_APPS, type NavApp } from "./builtInApps";
import { itemIcon } from "./itemIcons";

export { BUILT_IN_APPS, type NavApp };

/**
 * The apps this person pinned to their sidebar (``settings.nav_apps``) —
 * so an app can be used from inside Promptly without installing it.
 * ``apps`` resolves them in pinned order, skipping any they've since removed.
 */
export function useNavApps() {
  const pinnedIds = useAuthStore((s) => s.user?.settings?.nav_apps);
  // Simple line icons (matching the rest of the sidebar) unless the person
  // picked the apps' own colour icons.
  const iconStyle = useAuthStore((s) => s.user?.settings?.nav_app_icons) ?? "line";
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);
  const [saving, setSaving] = useState(false);
  const latestOrder = useRef(0);
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
      all.set(a.kind, { id: a.kind, name: a.name, icon: `/item-icons/${a.kind}-192.png`, glyph: itemIcon(a.icon), to: `/apps/${a.kind}` });
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

  /** Put the sidebar's apps in this order. Pins that can't be shown right now
   *  (an app that's gone) keep their place at the end. */
  const reorder = async (ids: string[]) => {
    const previous = pinned;
    const next = [...ids, ...previous.filter((k) => !ids.includes(k))];
    const turn = ++latestOrder.current;
    patchSettings({ nav_apps: next });
    try {
      const user = await authApi.updatePreferences({ nav_apps: next });
      // A quicker second move mustn't be undone by the first one's reply.
      if (turn === latestOrder.current) setUser(user);
    } catch (err) {
      if (turn === latestOrder.current) patchSettings({ nav_apps: previous });
      toast.error(extractError(err));
    }
  };

  const setIconStyle = async (style: "line" | "color") => {
    const previous = iconStyle;
    patchSettings({ nav_app_icons: style });
    try {
      setUser(await authApi.updatePreferences({ nav_app_icons: style }));
    } catch (err) {
      patchSettings({ nav_app_icons: previous });
      toast.error(extractError(err));
    }
  };

  return { pinned, apps, toggle, reorder, saving, iconStyle, setIconStyle };
}
