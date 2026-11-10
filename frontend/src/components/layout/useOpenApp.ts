import { useQuery } from "@tanstack/react-query";
import { Image } from "lucide-react";
import { useMemo } from "react";

import { itemsApi } from "@/items/api";
import { itemIcon } from "@/items/itemIcons";
import { useBuiltInApps, type NavApp } from "@/items/navApps";

/** Photos opens from Files and the Apps page, so it isn't in the built-in
 *  apps list; it still gets a row while it's open. */
const PHOTOS: NavApp = { id: "photos", name: "Photos", icon: "/pwa-photos-192.png", glyph: Image, to: "/photos" };

/** Pages under /apps that are the Apps page's own, not an app. */
const APPS_OWN = new Set(["store", "install"]);

const under = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

/**
 * "Where am I": the app that's open right now when it isn't one of the
 * sidebar's pinned apps (those light up on their own), so the sidebar can
 * show it as the current row under Apps. Null on ordinary pages.
 */
export function useOpenApp(pathname: string, pinned: NavApp[]): NavApp | null {
  const builtIn = useBuiltInApps();
  const kind = /^\/apps\/([^/]+)/.exec(pathname)?.[1];
  const storeKind = kind && !APPS_OWN.has(kind) ? kind : null;
  // The same cached list the Apps page and pinned apps use.
  const { data: launcher } = useQuery({
    queryKey: ["apps-launcher"],
    queryFn: itemsApi.launcher,
    enabled: storeKind !== null,
    staleTime: 60_000,
  });

  return useMemo(() => {
    if (pinned.some((a) => under(pathname, a.to))) return null;
    const app = [...builtIn, PHOTOS].find((a) => under(pathname, a.to));
    if (app) return app;
    if (!storeKind) return null;
    const found = launcher?.find((a) => a.kind === storeKind);
    return found
      ? { id: found.kind, name: found.name, icon: `/item-icons/${found.kind}-192.png`, glyph: itemIcon(found.icon), to: `/apps/${found.kind}` }
      : null;
  }, [pathname, pinned, builtIn, launcher, storeKind]);
}
