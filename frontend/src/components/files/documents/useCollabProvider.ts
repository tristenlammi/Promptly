import { useEffect, useRef, useState } from "react";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import * as Y from "yjs";

import { documentsApi, type CollabTokenResponse } from "@/api/documents";
import { epochWatcher, isResetPing, reloadForRestore } from "@/lib/collabReset";
import { collabRetryDelay, isFatalCollabError } from "@/lib/editorSync";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * Subscribes the editor to the Hocuspocus collab room for a
 * document.
 *
 * Lifecycle:
 *
 *  1. Build a Y.Doc + HocuspocusProvider pointed at the same-origin
 *     websocket ``wss://<host>/api/collab/<id>`` (nginx proxies it to the
 *     Node collab service). The provider's ``token`` is a *function*: it
 *     fetches a fresh short-lived JWT whenever it connects, reconnects or
 *     the server asks for one before the old one expires — there's no
 *     refresh timer to fail.
 *  2. A failed token fetch or a rejected reconnect is transient — a
 *     backend restart during a deploy, a laptop waking up — so it's
 *     retried with backoff while the editor stays mounted, and only a
 *     confirmed 403 / 404 ("you can't open this") is final (R-221).
 *  3. On unmount, destroy the provider + Y.Doc so the socket closes
 *     cleanly and the browser can GC the CRDT.
 */
export type CollabStatus = "connecting" | "connected" | "disconnected";

export interface UseCollabProviderResult {
  ydoc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  status: CollabStatus;
  user: CollabTokenResponse["user"] | null;
  /** Final: you can't open this document (403 / 404). The editor shows an
   *  error card only for this. */
  error: string | null;
  /** Transient trouble (retrying) — shown as a banner over a live editor. */
  warning: string | null;
  /** Server's edit permission from the token; ``null`` until known. */
  canEdit: boolean | null;
  /** True once the server's copy has been received. Until then the local
   *  Y.Doc is empty — nothing may be typed into it or saved from it. */
  synced: boolean;
  /** Local changes the server hasn't acknowledged yet (R-224). */
  unsynced: number;
  /** The edit generation this editor loaded (WP-6.2); null until known. */
  epoch: number | null;
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

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export function useCollabProvider(documentId: string): UseCollabProviderResult {
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [user, setUser] = useState<CollabTokenResponse["user"] | null>(null);
  // ``null`` until the first token arrives — callers treat unknown as
  // read-only so nobody types before their permission is known.
  const [canEdit, setCanEdit] = useState<boolean | null>(null);
  const [synced, setSynced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [unsynced, setUnsynced] = useState(0);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);

  const ydocRef = useRef<Y.Doc | null>(null);
  // The edit generation this editor loaded (WP-6.2) — a Save sends it.
  const epochRef = useRef(epochWatcher());

  // Freshly minted Y.Doc + provider per ``documentId``. Swapping
  // between docs tears the old session down cleanly so two
  // documents' CRDTs never bleed into each other.
  if (!ydocRef.current) {
    ydocRef.current = new Y.Doc();
  }

  useEffect(() => {
    let cancelled = false;
    let current: HocuspocusProvider | null = null;
    let reconnectTimer: number | null = null;
    let authFailures = 0;

    /** A fresh token, retried through transient failures. Throws only
     *  when the document is out of reach (or the hook unmounted). */
    const fetchToken = async (): Promise<string> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await documentsApi.getCollabToken(documentId);
          // Restored since this editor loaded → reload, don't merge.
          epochRef.current.seen(response.epoch);
          if (cancelled) throw new Error("closed");
          setUser(response.user);
          setCanEdit(response.can_edit ?? false);
          setWarning(null);
          return response.token;
        } catch (e) {
          if (cancelled) throw e;
          if (isFatalCollabError(e)) {
            setError(apiErrorMessage(e, "You can't open this document."));
            throw e;
          }
          setWarning(
            `Reconnecting to live editing… (${apiErrorMessage(e, "connection lost")}) Your edits are kept in this tab.`
          );
          await sleep(collabRetryDelay(attempt));
        }
      }
    };

    (async () => {
      try {
        // Fetch once up front so a document you can't open fails here,
        // before a socket is opened.
        const first = await fetchToken();
        let handedFirst = false;
        const p = new HocuspocusProvider({
          url: collabWebsocketUrl(documentId),
          name: documentId,
          document: ydocRef.current!,
          token: async () => {
            if (!handedFirst) {
              handedFirst = true;
              return first;
            }
            return fetchToken();
          },
          onSynced: ({ state }) => {
            if (!cancelled && state) setSynced(true);
          },
          onStateless: ({ payload }) => {
            if (isResetPing(payload)) reloadForRestore();
          },
          onStatus: ({ status: s }) => {
            if (cancelled) return;
            if (s === WebSocketStatus.Connected) setStatus("connected");
            else if (s === WebSocketStatus.Connecting) setStatus("connecting");
            else setStatus("disconnected");
          },
          onAuthenticated: () => {
            authFailures = 0;
            if (!cancelled) setWarning(null);
          },
          onUnsyncedChanges: ({ number }) => {
            if (!cancelled) setUnsynced(number);
          },
          onAuthenticationFailed: () => {
            if (cancelled) return;
            // Usually a token that expired while the socket was away. Try
            // again with a fresh one; keep the editor and its edits.
            setWarning("Reconnecting to live editing… Your edits are kept in this tab.");
            const delay = collabRetryDelay(authFailures++);
            if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
            reconnectTimer = window.setTimeout(() => {
              if (cancelled || !current) return;
              current.disconnect();
              void current.connect();
            }, delay);
          },
        });
        if (cancelled) {
          p.destroy();
          return;
        }
        current = p;
        setProvider(p);
      } catch {
        if (!cancelled) setStatus("disconnected");
      }
    })();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      current?.destroy();
      setProvider(null);
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
    provider,
    status,
    user,
    error,
    warning,
    canEdit,
    synced,
    unsynced,
    /** The edit generation this editor loaded (null until known). */
    epoch: epochRef.current.loaded,
  };
}
