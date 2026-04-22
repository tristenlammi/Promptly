import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import {
  localModelsApi,
  type PullEvent,
} from "@/api/localModels";
import { useAuthStore } from "@/store/authStore";
import { AVAILABLE_MODELS_KEY } from "@/hooks/useProviders";

export const INSTALLED_MODELS_KEY = ["local-models", "installed"] as const;
export const LIBRARY_KEY = ["local-models", "library"] as const;
export const HARDWARE_KEY = ["local-models", "hardware"] as const;

export function useInstalledLocalModels() {
  return useQuery({
    queryKey: INSTALLED_MODELS_KEY,
    queryFn: () => localModelsApi.listInstalled(),
    // Keep the list reasonably fresh so the installed badge on
    // library cards stays accurate without spamming Ollama.
    staleTime: 15_000,
  });
}

export function useLocalModelsLibrary() {
  return useQuery({
    queryKey: LIBRARY_KEY,
    queryFn: () => localModelsApi.library(),
    staleTime: Infinity,
  });
}

export function useHardwareProbe() {
  return useQuery({
    queryKey: HARDWARE_KEY,
    queryFn: () => localModelsApi.hardware(),
    staleTime: 60_000,
  });
}

export function useDeleteLocalModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => localModelsApi.deleteInstalled(name),
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: INSTALLED_MODELS_KEY });
      // Re-register with the Ollama provider so deleted models
      // disappear from the chat picker without a full page reload.
      try {
        await localModelsApi.refreshProvider();
      } catch {
        // best-effort — refresh failures are surfaced next time
        // the admin opens the panel.
      }
      qc.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
    },
  });
}

/**
 * Track one in-flight Ollama model pull.
 *
 * Returns a tuple of ``{progress, start, cancel}`` — ``progress`` is
 * the latest SSE event (or ``null`` before the first frame), ``start``
 * kicks off a new pull (cancelling any running one), and ``cancel``
 * aborts via the underlying ``AbortController``.
 *
 * After a successful pull completes the hook calls
 * ``refreshProvider`` so the newly-pulled model shows up in the
 * model picker immediately.
 */
export function useModelPull() {
  const qc = useQueryClient();
  const accessToken = useAuthStore((s) => s.accessToken);
  const [active, setActive] = useState<string | null>(null);
  const [progress, setProgress] = useState<PullEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    async (name: string) => {
      // Kill any in-flight pull so we don't interleave streams.
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      setActive(name);
      setProgress(null);
      setError(null);

      try {
        for await (const evt of localModelsApi.streamPull(name, {
          signal: ac.signal,
          accessToken,
        })) {
          if (evt.error) {
            setError(evt.detail ?? "Pull failed");
            break;
          }
          setProgress(evt);
          if (evt.done) break;
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : "Pull failed");
        }
      } finally {
        setActive(null);
        qc.invalidateQueries({ queryKey: INSTALLED_MODELS_KEY });
        try {
          await localModelsApi.refreshProvider();
        } catch {
          // no-op — refresh failures are non-fatal.
        }
        qc.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
      }
    },
    [accessToken, qc]
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setActive(null);
  }, []);

  return { active, progress, error, start, cancel };
}
