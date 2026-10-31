import { useQuery } from "@tanstack/react-query";

import { itemsApi, type StoreItem } from "./api";

/**
 * The Store catalog, cached app-wide (the New menu, Files icons and the
 * Store page share it). Also fills {@link itemLook} so plain components
 * (Drive's file icons) can colour an item file by its kind synchronously.
 */
export function useItemCatalog() {
  return useQuery({
    queryKey: ["installed-items"],
    queryFn: async () => {
      const res = await itemsApi.store();
      remember(res.items);
      return res.items;
    },
    staleTime: 5 * 60_000,
  });
}

/** The items this person added (what New offers). */
export function useInstalledItems(): StoreItem[] {
  const { data } = useItemCatalog();
  return (data ?? []).filter((i) => i.installed && !i.disabled);
}

const looks: { suffix: string; kind: string; icon: string; color: string; name: string }[] = [];

function remember(items: StoreItem[]) {
  looks.length = 0;
  for (const i of items) looks.push({ suffix: i.suffix.toLowerCase(), kind: i.kind, icon: i.icon, color: i.color, name: i.name });
}

/** An item file's kind look (icon name, colour, app name), from its name. */
export function itemLook(filename: string): { kind: string; icon: string; color: string; name: string } | null {
  const lower = (filename || "").toLowerCase();
  return looks.find((l) => lower.endsWith(l.suffix)) ?? null;
}
