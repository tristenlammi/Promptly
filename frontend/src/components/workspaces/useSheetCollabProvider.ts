import { useEffect, useRef, useState } from "react";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";

import { workspacesApi } from "@/api/workspaces";
import type { CollabTokenResponse } from "@/api/documents";

/**
 * Subscribes a Fortune-sheet workbook to the Hocuspocus collab room for a
 * sheet. The sheet twin of ``useCanvasCollabProvider`` — same lifecycle and
 * token-refresh dance; the only differences are the token endpoint
 * (``workspacesApi.getSheetCollabToken``) and the ``sheet:`` room prefix, so
 * the collab server routes persistence to the ``spreadsheets`` table.
 */
export type SheetCollabStatus = "connecting" | "connected" | "disconnected";

export interface UseSheetCollabProviderResult {
  ydoc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  status: SheetCollabStatus;
  user: CollabTokenResponse["user"] | null;
  error: string | null;
}

function sheetWebsocketUrl(sheetId: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/api/collab/sheet:${sheetId}`;
}

export function useSheetCollabProvider(
  workspaceId: string,
  sheetId: string
): UseSheetCollabProviderResult {
  const [status, setStatus] = useState<SheetCollabStatus>("connecting");
  const [user, setUser] = useState<CollabTokenResponse["user"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);

  const providerRef = useRef<HocuspocusProvider | null>(null);
  const tokenRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

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
        const response = await workspacesApi.getSheetCollabToken(
          workspaceId,
          sheetId
        );
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
          setError(
            e instanceof Error ? e.message : "Failed to refresh collab token"
          );
        }
      }
    };

    (async () => {
      try {
        const response = await workspacesApi.getSheetCollabToken(
          workspaceId,
          sheetId
        );
        if (cancelled) return;
        tokenRef.current = response.token;
        setUser(response.user);
        scheduleRefresh(response.expires_at);

        const p = new HocuspocusProvider({
          url: sheetWebsocketUrl(sheetId),
          name: `sheet:${sheetId}`,
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
          setError(
            e instanceof Error ? e.message : "Failed to start collaboration"
          );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, sheetId]);

  return { ydoc, provider, status, user, error };
}
