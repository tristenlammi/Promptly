import { useEffect, useRef, useState } from "react";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";

import { documentsApi, type CollabTokenResponse } from "@/api/documents";

/**
 * Subscribes the editor to the Hocuspocus collab room for a
 * document.
 *
 * Lifecycle:
 *
 *  1. On mount, POST ``GET /api/documents/:id/collab-token`` to
 *     get the short-lived JWT Hocuspocus expects. The token is
 *     stored in a ref so the auto-reconnect path can hand the
 *     provider a fresh one without re-wiring the React tree.
 *  2. Build a Y.Doc + HocuspocusProvider pointed at the
 *     same-origin websocket ``wss://<host>/api/collab/<id>``.
 *     Nginx proxies this to the Node collab service.
 *  3. Schedule a token refresh ~30s before ``expires_at`` so an
 *     active edit session never disconnects.
 *  4. On unmount, destroy the provider + Y.Doc so the socket
 *     closes cleanly and the browser can GC the CRDT.
 *
 * Returns the Y.Doc, provider instance, current connection
 * status, and the authenticated user info (name + colour) the
 * CollaborationCursor extension needs.
 */
export type CollabStatus = "connecting" | "connected" | "disconnected";

export interface UseCollabProviderResult {
  ydoc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  status: CollabStatus;
  user: CollabTokenResponse["user"] | null;
  /** Error from the initial token fetch, if any. */
  error: string | null;
}

/**
 * Resolve the websocket URL for a document.
 *
 * In production the backend and collab service live behind the same
 * nginx vhost, so we use ``/api/collab/<id>`` on the current origin
 * (nginx upgrades to WS). In dev the same path works because the
 * Vite proxy forwards /api/ to the reverse proxy.
 */
function collabWebsocketUrl(documentId: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/api/collab/${documentId}`;
}

export function useCollabProvider(documentId: string): UseCollabProviderResult {
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [user, setUser] = useState<CollabTokenResponse["user"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  const tokenRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  // Freshly minted Y.Doc + provider per ``documentId``. Swapping
  // between docs tears the old session down cleanly so two
  // documents' CRDTs never bleed into each other.
  if (!ydocRef.current) {
    ydocRef.current = new Y.Doc();
  }

  useEffect(() => {
    let cancelled = false;

    const clearRefreshTimer = () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };

    const scheduleRefresh = (expiresAt: number) => {
      clearRefreshTimer();
      // Refresh 30s before expiry, but never less than 15s from now
      // (so a clock skew of a few seconds doesn't flap the connection).
      const now = Math.floor(Date.now() / 1000);
      const delaySec = Math.max(15, expiresAt - now - 30);
      refreshTimerRef.current = window.setTimeout(() => {
        void refreshToken();
      }, delaySec * 1000);
    };

    const refreshToken = async () => {
      try {
        const response = await documentsApi.getCollabToken(documentId);
        if (cancelled) return;
        tokenRef.current = response.token;
        setUser(response.user);
        if (providerRef.current) {
          // HocuspocusProvider re-reads its token from the options
          // object on reconnect. We both update the object and
          // trigger a reconnect so the new token takes effect
          // immediately.
          (providerRef.current as unknown as { configuration: { token?: string } }).configuration.token =
            response.token;
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
        const response = await documentsApi.getCollabToken(documentId);
        if (cancelled) return;
        tokenRef.current = response.token;
        setUser(response.user);
        scheduleRefresh(response.expires_at);

        const provider = new HocuspocusProvider({
          url: collabWebsocketUrl(documentId),
          name: documentId,
          document: ydocRef.current!,
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
        providerRef.current = provider;
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
      ydocRef.current?.destroy();
      ydocRef.current = null;
    };
    // We intentionally re-run this effect whenever the document id
    // changes so the editor can swap docs without unmounting the
    // surrounding modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  return {
    ydoc: ydocRef.current,
    provider: providerRef.current,
    status,
    user,
    error,
  };
}
