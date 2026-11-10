import { useQuery } from "@tanstack/react-query";

import { todayApi, type TodayData } from "@/api/today";

/**
 * The Today hub's data, shared with the Today page (same cache key), for
 * the feeds that read from it: next event, next reminder, recordings being
 * written up. Asked for gently: every five minutes while the tab is visible
 * and when you come back to the window. Fails silently.
 */
export function useDockToday(): TodayData | undefined {
  const { data } = useQuery({
    queryKey: ["today"],
    queryFn: todayApi.get,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return data;
}

/** Follow a link from the hub: inside Promptly when it's one of ours. */
export function go(navigate: (to: string) => void, url: string | null | undefined, fallback: string): void {
  if (!url) navigate(fallback);
  else if (url.startsWith("/")) navigate(url);
  else window.location.assign(url);
}
