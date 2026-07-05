import { useCallback, useEffect, useRef, useState } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { reconcileElements, CaptureUpdateAction } from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  SocketId,
} from "@excalidraw/excalidraw/types";

import type { CollabTokenResponse } from "@/api/documents";

/**
 * Binds an Excalidraw scene to a shared ``Y.Doc`` from a Hocuspocus
 * provider — the Excalidraw twin of the old tldraw ``useYjsCanvasStore``.
 *
 * Document sync (two-way, loop-free):
 *  - Elements live in a ``Y.Map<element>`` keyed by element id; image
 *    blobs in a ``Y.Map<BinaryFileData>`` keyed by file id.
 *  - **Change detection is value-based, never identity-based.** Excalidraw
 *    freezes/replaces element objects as you edit, so we must NOT compare
 *    live objects to what's in the Y.Map (that compares an object to
 *    itself). Instead we keep a ``syncedSnapshot`` of each element's
 *    ``version:versionNonce`` and, on change, write a **deep clone** of
 *    any element whose signature moved. (The earlier reference-based
 *    binding wrote each element only once — at creation, when a rectangle
 *    is genuinely 0×0 — so peers/reloads saw "tiny dots".)
 *  - Remote Y.Map changes (``origin !== LOCAL_ORIGIN``) are merged with
 *    ``reconcileElements`` and applied via ``updateScene`` with
 *    ``CaptureUpdateAction.NEVER`` (kept out of the local undo stack). The
 *    snapshot is refreshed from the applied elements so the resulting
 *    ``onChange`` is recognised as a no-op and doesn't echo.
 *
 * Presence (live cursors) rides the provider's ``awareness``.
 */

type SceneElement = ReturnType<
  ExcalidrawImperativeAPI["getSceneElementsIncludingDeleted"]
>[number];

// Tags our own Yjs writes so the observer can skip them (no echo loop).
const LOCAL_ORIGIN = "excalidraw-local";

// Per-element change signature. Excalidraw guarantees a fresh
// ``versionNonce`` on every mutation, so this moves whenever an element
// actually changes — independent of object identity.
const sig = (el: SceneElement): string => `${el.version}:${el.versionNonce}`;

// Deep, unfrozen copy so Excalidraw's later in-place edits can't mutate
// what we've handed to Yjs. Elements are JSON by design (that's how
// Excalidraw serialises scenes), so a JSON round-trip is safe.
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface ExcalidrawCanvasBinding {
  /** Wire to ``<Excalidraw onChange>``. */
  onChange: (
    elements: readonly SceneElement[],
    appState: unknown,
    files: BinaryFiles
  ) => void;
  /** Wire to ``<Excalidraw onPointerUpdate>``. */
  onPointerUpdate: (payload: {
    pointer: { x: number; y: number; tool: "pointer" | "laser" };
    button: "down" | "up";
  }) => void;
  /** Clear our shared cursor (e.g. when the pointer leaves the board). */
  clearPointer: () => void;
  /** True once the binding is live. */
  ready: boolean;
}

export function useExcalidrawCanvas({
  excalidrawAPI,
  ydoc,
  provider,
  user,
  readOnly,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  ydoc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  user: CollabTokenResponse["user"] | null;
  readOnly: boolean;
}): ExcalidrawCanvasBinding {
  const [ready, setReady] = useState(false);

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const yElementsRef = useRef<Y.Map<SceneElement> | null>(null);
  const yFilesRef = useRef<Y.Map<BinaryFileData> | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<HocuspocusProvider["awareness"] | null>(null);
  const readyRef = useRef(false);
  const readOnlyRef = useRef(readOnly);
  // id -> last-synced ``version:versionNonce``. The source of truth for
  // "did this element change", kept current by BOTH the local-write path
  // and the remote-apply path so neither echoes the other.
  const snapshotRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);

  useEffect(() => {
    if (!excalidrawAPI || !ydoc || !provider) {
      readyRef.current = false;
      setReady(false);
      return;
    }

    const yElements = ydoc.getMap<SceneElement>("elements");
    const yFiles = ydoc.getMap<BinaryFileData>("files");
    const awareness = provider.awareness;
    const snapshot = snapshotRef.current;

    apiRef.current = excalidrawAPI;
    yElementsRef.current = yElements;
    yFilesRef.current = yFiles;
    ydocRef.current = ydoc;
    awarenessRef.current = awareness;

    const unsubs: Array<() => void> = [];

    // ----- Yjs -> scene -------------------------------------------------
    const applyRemoteElements = () => {
      const api = apiRef.current;
      if (!api) return;
      const remote = [...yElements.values()];
      if (remote.length === 0) return;
      const local = api.getSceneElementsIncludingDeleted();
      const reconciled = reconcileElements(
        local,
        remote as unknown as Parameters<typeof reconcileElements>[1],
        api.getAppState()
      );
      api.updateScene({
        elements: reconciled,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      // Mark everything we just applied as already-synced so the onChange
      // this updateScene fires doesn't re-broadcast it.
      for (const el of reconciled) snapshot.set(el.id, sig(el));
    };

    const elementsObserver = (
      _e: Y.YMapEvent<SceneElement>,
      txn: Y.Transaction
    ) => {
      if (txn.origin === LOCAL_ORIGIN) return;
      applyRemoteElements();
    };
    yElements.observe(elementsObserver);
    unsubs.push(() => yElements.unobserve(elementsObserver));

    const filesObserver = (
      e: Y.YMapEvent<BinaryFileData>,
      txn: Y.Transaction
    ) => {
      if (txn.origin === LOCAL_ORIGIN) return;
      const api = apiRef.current;
      if (!api) return;
      const added: BinaryFileData[] = [];
      e.keysChanged.forEach((id) => {
        const f = yFiles.get(id);
        if (f) added.push(f);
      });
      if (added.length) api.addFiles(added);
    };
    yFiles.observe(filesObserver);
    unsubs.push(() => yFiles.unobserve(filesObserver));

    // ----- Presence (live cursors) -------------------------------------
    if (awareness) {
      if (user) {
        awareness.setLocalStateField("user", {
          name: user.name,
          color: user.color,
          id: user.id,
          avatar: user.avatar ?? null,
        });
      }
      const awarenessObserver = () => {
        const api = apiRef.current;
        if (!api) return;
        const collaborators = new Map<SocketId, Collaborator>();
        awareness.getStates().forEach((state, clientId) => {
          if (clientId === awareness.clientID) return;
          const u = state.user as
            | {
                name?: string;
                color?: string;
                id?: string;
                avatar?: string | null;
              }
            | undefined;
          const pointer = state.pointer as Collaborator["pointer"] | undefined;
          // Only surface peers with a live pointer — avoids ghost cursors
          // for idle / half-torn-down states.
          if (!pointer) return;
          const color = u?.color;
          collaborators.set(String(clientId) as SocketId, {
            pointer,
            button: state.button as "up" | "down" | undefined,
            username: u?.name ?? "Anonymous",
            color: color ? { background: color, stroke: color } : undefined,
            id: u?.id,
            // Excalidraw renders this on the cursor label + laser chip.
            avatarUrl: u?.avatar ?? undefined,
          });
        });
        api.updateScene({ collaborators });
      };
      awareness.on("change", awarenessObserver);
      unsubs.push(() => awareness.off("change", awarenessObserver));
    }

    // ----- Initial sync ------------------------------------------------
    const seed = () => {
      const api = apiRef.current;
      applyRemoteElements();
      if (api) {
        const files = [...yFiles.values()];
        if (files.length) api.addFiles(files);
      }
      readyRef.current = true;
      setReady(true);
    };

    if (provider.isSynced) {
      seed();
    } else {
      const onSynced = () => {
        provider.off("synced", onSynced);
        seed();
      };
      provider.on("synced", onSynced);
      unsubs.push(() => provider.off("synced", onSynced));
      readyRef.current = true;
      setReady(true);
    }

    return () => {
      unsubs.forEach((fn) => {
        try {
          fn();
        } catch {
          /* best-effort teardown */
        }
      });
      try {
        awareness?.setLocalState(null);
      } catch {
        /* ignore */
      }
      apiRef.current = null;
      yElementsRef.current = null;
      yFilesRef.current = null;
      ydocRef.current = null;
      awarenessRef.current = null;
      readyRef.current = false;
      snapshot.clear();
      setReady(false);
    };
  }, [excalidrawAPI, ydoc, provider, user?.id, user?.name, user?.color]);

  // ----- scene -> Yjs (stable handler) ---------------------------------
  const onChange = useCallback(
    (_elements: readonly SceneElement[], _appState: unknown, files: BinaryFiles) => {
      if (!readyRef.current || readOnlyRef.current) return;
      const api = apiRef.current;
      const yElements = yElementsRef.current;
      const yFiles = yFilesRef.current;
      const ydoc = ydocRef.current;
      if (!api || !yElements || !ydoc) return;

      const snapshot = snapshotRef.current;
      // Including-deleted so deletions (isDeleted=true) propagate too.
      const all = api.getSceneElementsIncludingDeleted();
      const changed = all.filter((el) => snapshot.get(el.id) !== sig(el));

      const newFileIds = yFiles
        ? Object.keys(files).filter((id) => !yFiles.get(id))
        : [];

      if (changed.length === 0 && newFileIds.length === 0) return;

      ydoc.transact(() => {
        for (const el of changed) {
          yElements.set(el.id, clone(el));
          snapshot.set(el.id, sig(el));
        }
        if (yFiles) {
          for (const id of newFileIds) yFiles.set(id, clone(files[id]));
        }
      }, LOCAL_ORIGIN);
    },
    []
  );

  const onPointerUpdate = useCallback(
    (payload: {
      pointer: { x: number; y: number; tool: "pointer" | "laser" };
      button: "down" | "up";
    }) => {
      const awareness = awarenessRef.current;
      if (!awareness || readOnlyRef.current) return;
      awareness.setLocalStateField("pointer", payload.pointer);
      awareness.setLocalStateField("button", payload.button);
    },
    []
  );

  const clearPointer = useCallback(() => {
    const awareness = awarenessRef.current;
    if (!awareness) return;
    // Drop just the pointer so peers stop rendering our cursor; keep our
    // ``user`` so we still appear in the collaborator list.
    awareness.setLocalStateField("pointer", null);
  }, []);

  return { onChange, onPointerUpdate, clearPointer, ready };
}
