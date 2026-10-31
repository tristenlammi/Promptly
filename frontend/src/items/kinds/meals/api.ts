import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { apiClient } from "@/api/client";

import type { Food, FoundFood, MealsData, TrendsResponse } from "./types";

/* The kind's own endpoints (backend: app/items/kinds/meals/off.py), at
 * /api/items/k/meals/… — Open Food Facts is always queried server-side. */

const BASE = "/items/k/meals";

export function useBuiltins() {
  return useQuery({
    queryKey: ["items", "meals", "builtin"],
    queryFn: async () => {
      const { data } = await apiClient.get<{ foods: Food[]; categories: string[] }>(`${BASE}/builtin/foods`);
      return data;
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export async function lookupBarcode(code: string): Promise<FoundFood | null> {
  try {
    const { data } = await apiClient.get<{ food: FoundFood }>(`${BASE}/off/barcode/${encodeURIComponent(code)}`, { timeout: 20_000 });
    return data.food;
  } catch (e) {
    if ((e as { response?: { status?: number } })?.response?.status === 404) return null;
    throw e;
  }
}

export async function searchOnline(q: string): Promise<FoundFood[]> {
  const { data } = await apiClient.get<{ foods: FoundFood[] }>(`${BASE}/off/search`, { params: { q }, timeout: 25_000 });
  return data.foods;
}

export function useTrends(fileId: string, revision: number, days: number) {
  return useQuery({
    queryKey: ["items", "meals", "trends", fileId, days, revision],
    queryFn: async () => {
      const { data } = await apiClient.get<TrendsResponse>(`${BASE}/trends/${fileId}`, { params: { days } });
      return data;
    },
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

/** Library + built-ins, one resolver for ``food_ref``s. */
export function useFoodPool(data: MealsData) {
  const { data: builtin } = useBuiltins();
  const builtins = builtin?.foods;
  const byId = useMemo(() => {
    const m = new Map<string, Food>();
    for (const f of builtins ?? []) m.set(f.id, f);
    for (const f of data.foods) m.set(f.id, f);
    return m;
  }, [builtins, data.foods]);
  const pool = useMemo(() => [...data.foods, ...(builtins ?? [])], [data.foods, builtins]);
  const resolve = useCallback((ref: string | null | undefined) => (ref ? byId.get(ref) ?? null : null), [byId]);
  const favs = useMemo(() => new Set(data.favourites), [data.favourites]);
  return { pool, resolve, favs, builtins: builtins ?? [], categories: builtin?.categories ?? [], loading: !builtin };
}
