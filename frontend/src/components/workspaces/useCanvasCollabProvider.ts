import { useEffect, useRef, useState } from "react";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";

import { canvasApi } from "@/api/canvas";
import type { CollabTokenResponse } from "@/api/documents";

/**
 * Subscribes an Excalidraw board to the Hocuspocus collab room for a canvas.
 *
 * This is the canvas twin of ``useCollabProvider`` (documents). Same
 * lifecycle, same token-refresh dance — the only differences are the
 * token endpoint (``canvasApi.getCollabToken``) and the room name, which
 * is prefixed ``canvas:`` so the collab server routes it to the canvas
 * table rather than the documents table.
 *
 *  1. On mount, fetch the short-lived collab JWT. Stored in a ref so the
 *     auto-reconnect path can hand the provider a fresh token without
 *     re-wiring the React tree.
 *  2. Build a Y.Doc + HocuspocusProvider pointed at
 *     ``wss://<host>/api/collab/canvas:<id>`` with ``name: "canvas:<id>"``.
 *  3. Schedule a refresh ~30s before ``expires_at``.
 *  4. On unmount, destroy the provider + Y.Doc so the socket closes and
 *     the CRDT can be GC'd.
 *
 * Returns the Y.Doc, provider, connection status, and presence identity
 * (name + colour) for Excalidraw's awareness-based cursors.
 */
export type CanvasCollabStatus = "connecting" | "connected" | "disconnected";

export interface UseCanvasCollabProviderResult {
  ydoc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  status: CanvasCollabStatus;
  user: CollabTokenResponse["user"] | null;
  /** Error from the initial token fetch, if any. */
  error: string | null;
}

/**
 * Resolve the websocket URL for a canvas room.
 *
 * Mirrors ``collabWebsocketUrl`` but includes the ``canvas:`` prefix in
 * the path so the collab server's room router sends it to the canvas
 * table. nginx proxies ``/api/collab/*`` and upgrades to WS.
 */
function canvasWebsocketUrl(canvasId: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/api/collab/canvas:${canvasId}`;
}

export function useCanvasCollabProvider(
  canvasId: string
): UseCanvasCollabProviderResult {
  const [status, setStatus] = useState<CanvasCollabStatus>("connecting");
  const [user, setUser] = useState<CollabTokenResponse["user"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ``ydoc`` + ``provider`` are mirrored into state so the binding hook /
  // <Excalidraw> re-render once they exist. Both are created *inside* the
  // effect (not via a lazy ref during render) so teardown can null them
  // without risking the next effect run reading a destroyed doc.
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);

  const providerRef = useRef<HocuspocusProvider | null>(null);
  const tokenRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Freshly minted Y.Doc per ``canvasId`` so two canvases' CRDTs never
    // bleed into each other.
    const doc = new Y.Doc();
    setYdoc(doc);

    const clearRefreshTimer = () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };

    const scheduleRefresh = (expiresAt: number) => {
      clearRefreshTimer();
      const now = Math.floor(Date.now() / 1000);
      const delaySec = Math.max(15, expiresAt - now - 30);
      refreshTimerRef.current = window.setTimeout(() => {
        void refreshToken();
      }, delaySec * 1000);
    };

    const refreshToken = async () => {
      try {
        const response = await canvasApi.getCollabToken(canvasId);
        if (cancelled) return;
        tokenRef.current = response.token;
        setUser(response.user);
        if (providerRef.current) {
          (
            providerRef.current as unknown as {
              configuration: { token?: string };
            }
          ).configuration.token = response.token;
        }
        scheduleRefresh(response.expires_at);
      } catch (e) {
        if (!cancelled) {
          const msg =
            e instanceof Error ? e.message : "Failed to refresh collab token";
          setError(msg);
        }
      }
    };

    (async () => {
      try {
        const response = await canvasApi.getCollabToken(canvasId);
        if (cancelled) return;
        tokenRef.current = response.token;
        setUser(response.user);
        scheduleRefresh(response.expires_at);

        const p = new HocuspocusProvider({
          url: canvasWebsocketUrl(canvasId),
          name: `canvas:${canvasId}`,
          document: doc,
          token: response.token,
          onStatus: ({ status: s }) => {
            if (cancelled) return;
            if (s === WebSocketStatus.Connected) setStatus("connected");
            else if (s === WebSocketStatus.Connecting) setStatus("connecting");
            else setStatus("disconnected");
          },
          onAuthenticationFailed: ({ reason }) => {
            if (cancelled) return;
            setError(reason || "Collaboration session rejected");
          },
        });
        providerRef.current = p;
        setProvider(p);
      } catch (e) {
        if (!cancelled) {
          const msg =
            e instanceof Error ? e.message : "Failed to start collaboration";
          setError(msg);
          setStatus("disconnected");
        }
      }
    })();

    return () => {
      cancelled = true;
      clearRefreshTimer();
      providerRef.current?.destroy();
      providerRef.current = null;
      setProvider(null);
      doc.destroy();
      setYdoc(null);
    };
    // Re-run whenever the canvas id changes so the board can swap rooms.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId]);

  return {
    ydoc,
    provider,
    status,
    user,
    error,
  };
}
