import { useCallback, useEffect, useRef, useState } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import {
  reconcileElements,
  getSceneVersion,
  CaptureUpdateAction,
} from "@excalidraw/excalidraw";
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
 * Unlike tldraw (which takes a pre-built store), Excalidraw is driven
 * imperatively through its ``excalidrawAPI``: we seed nothing up front,
 * forward local edits via ``onChange``, and push remote edits in with
 * ``updateScene``. The collab provider, token auth, and Postgres
 * persistence are unchanged — only the editor-specific binding differs.
 *
 * Document sync (two-way, loop-free):
 *  - Elements live in a ``Y.Map<element>`` keyed by element id; image
 *    blobs in a ``Y.Map<BinaryFileData>`` keyed by file id.
 *  - Local ``onChange`` diffs by element ``version`` and writes changed
 *    elements inside a ``ydoc.transact(..., LOCAL_ORIGIN)``.
 *  - Remote Y.Map changes (``origin !== LOCAL_ORIGIN``) are merged with
 *    ``reconcileElements`` and applied via ``updateScene`` with
 *    ``CaptureUpdateAction.NEVER`` so they don't pollute the local user's
 *    undo stack.
 *  - ``getSceneVersion`` gates the local path: Excalidraw fires
 *    ``onChange`` on pure pointer/selection churn too, and we must not
 *    re-broadcast (or echo back) what didn't actually change.
 *
 * Presence (live cursors) rides the provider's ``awareness``: the local
 * pointer + identity are published on ``onPointerUpdate``; remote states
 * are mirrored into the scene as Excalidraw ``collaborators``.
 */

// Element type, derived from the API so we don't depend on Excalidraw's
// internal element type-paths (which move between releases).
type SceneElement = ReturnType<
  ExcalidrawImperativeAPI["getSceneElementsIncludingDeleted"]
>[number];

// Tags our own Yjs writes so the observer can skip them (no echo loop).
const LOCAL_ORIGIN = "excalidraw-local";

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
  /** True once the binding is live (editor interactive; remote state
   *  streams in via the observer as it arrives). */
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

  // The stable ``onChange`` / ``onPointerUpdate`` handlers read the live
  // binding internals through refs (the handlers are created once but the
  // Yjs/awareness targets are recreated per effect run).
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const yElementsRef = useRef<Y.Map<SceneElement> | null>(null);
  const yFilesRef = useRef<Y.Map<BinaryFileData> | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<HocuspocusProvider["awareness"] | null>(null);
  const readyRef = useRef(false);
  const readOnlyRef = useRef(readOnly);
  // Last scene version we've already reconciled — both the local-edit gate
  // and the remote-apply path keep this current so neither echoes.
  const lastSceneVersionRef = useRef<number>(-1);

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
        // reconcileElements brands remote elements internally — cast through.
        remote as unknown as Parameters<typeof reconcileElements>[1],
        api.getAppState()
      );
      api.updateScene({
        elements: reconciled,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      // Keep the gate current so the onChange this updateScene triggers
      // doesn't re-broadcast what we just applied.
      lastSceneVersionRef.current = getSceneVersion(
        api.getSceneElementsIncludingDeleted()
      );
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
        });
      }
      const awarenessObserver = () => {
        const api = apiRef.current;
        if (!api) return;
        const collaborators = new Map<SocketId, Collaborator>();
        awareness.getStates().forEach((state, clientId) => {
          if (clientId === awareness.clientID) return;
          const u = state.user as
            | { name?: string; color?: string; id?: string }
            | undefined;
          const color = u?.color;
          collaborators.set(String(clientId) as SocketId, {
            pointer: state.pointer as Collaborator["pointer"] | undefined,
            button: state.button as "up" | "down" | undefined,
            username: u?.name ?? "Anonymous",
            color: color ? { background: color, stroke: color } : undefined,
            id: u?.id,
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
      // Mark ready immediately so the board is interactive while the first
      // sync lands; remote elements stream in through the observer.
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
      // Drop our awareness footprint so our cursor disappears for peers.
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
      lastSceneVersionRef.current = -1;
      setReady(false);
    };
  }, [excalidrawAPI, ydoc, provider, user?.id, user?.name, user?.color]);

  // ----- scene -> Yjs (stable handler) ---------------------------------
  const onChange = useCallback(
    (elements: readonly SceneElement[], _appState: unknown, files: BinaryFiles) => {
      if (!readyRef.current || readOnlyRef.current) return;
      const yElements = yElementsRef.current;
      const yFiles = yFilesRef.current;
      const ydoc = ydocRef.current;
      if (!yElements || !ydoc) return;

      // Gate on a real element change — onChange also fires on selection /
      // pointer churn that never touches the synced element set.
      const version = getSceneVersion(elements);
      if (version === lastSceneVersionRef.current) return;
      lastSceneVersionRef.current = version;

      ydoc.transact(() => {
        for (const el of elements) {
          const existing = yElements.get(el.id);
          if (!existing || existing.version !== el.version) {
            yElements.set(el.id, el);
          }
        }
        // New image blobs (paste/drop) ride alongside the element that
        // references them — the element version bump got us here.
        if (yFiles && files) {
          for (const [id, file] of Object.entries(files)) {
            if (!yFiles.get(id)) yFiles.set(id, file);
          }
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
      if (!awareness) return;
      awareness.setLocalStateField("pointer", payload.pointer);
      awareness.setLocalStateField("button", payload.button);
    },
    []
  );

  return { onChange, onPointerUpdate, ready };
}
