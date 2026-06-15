import { useEffect, useState } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import {
  computed,
  createPresenceStateDerivation,
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  getUserPreferences,
  InstancePresenceRecordType,
  react,
  transact,
  UserRecordType,
  type TLAnyBindingUtilConstructor,
  type TLAnyShapeUtilConstructor,
  type TLInstancePresence,
  type TLRecord,
  type TLStoreWithStatus,
  type TLUser,
} from "tldraw";

import type { CollabTokenResponse } from "@/api/documents";

/**
 * Binds a tldraw ``TLStore`` to a shared ``Y.Doc`` from a Hocuspocus
 * provider, following tldraw's official ``tldraw-yjs-example``
 * (``useYjsStore``) approach.
 *
 * Two-way document sync:
 *  - tldraw records live in a ``Y.Map<TLRecord>`` keyed by record id.
 *  - Local store changes (``store.listen`` with ``source: "user"``) are
 *    written into the Y.Map inside a single ``yDoc.transact``.
 *  - Remote Y.Map changes are applied back into the store inside
 *    ``store.mergeRemoteChanges`` so they don't echo back out as local
 *    edits (which would loop).
 *
 * Presence (live cursors) rides the provider's ``awareness``:
 *  - A ``createPresenceStateDerivation`` signal turns the local user +
 *    store into a ``TLInstancePresence`` record, pushed to awareness.
 *  - Remote awareness states are mirrored into the store as presence
 *    records so tldraw renders other people's cursors/selections.
 *
 * If presence wiring fails for any reason it's caught and logged — shape
 * sync (the must-have) keeps working even if cursors degrade.
 */

const shapeUtils: TLAnyShapeUtilConstructor[] = [...defaultShapeUtils];
const bindingUtils: TLAnyBindingUtilConstructor[] = [...defaultBindingUtils];

export function useYjsCanvasStore({
  ydoc,
  provider,
  user,
}: {
  ydoc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  user: CollabTokenResponse["user"] | null;
}): TLStoreWithStatus {
  const [storeWithStatus, setStoreWithStatus] = useState<TLStoreWithStatus>({
    status: "loading",
  });

  useEffect(() => {
    if (!ydoc || !provider) {
      setStoreWithStatus({ status: "loading" });
      return;
    }

    // A fresh store per (doc, provider). Shape + binding utils must match
    // what <Tldraw> renders with.
    const store = createTLStore({ shapeUtils, bindingUtils });
    const yRecords: Y.Map<TLRecord> = ydoc.getMap<TLRecord>("tl_records");
    // ``awareness`` can be null if the provider was built with awareness
    // disabled — presence simply degrades in that case.
    const awareness = provider.awareness;

    const unsubs: Array<() => void> = [];

    // ----- Local store -> Yjs -------------------------------------------
    const handleStoreChange = () => {
      const storeListener = store.listen(
        ({ changes }) => {
          ydoc.transact(() => {
            for (const record of Object.values(changes.added)) {
              yRecords.set(record.id, record);
            }
            for (const [, record] of Object.values(changes.updated)) {
              yRecords.set(record.id, record);
            }
            for (const record of Object.values(changes.removed)) {
              yRecords.delete(record.id);
            }
          });
        },
        // Only mirror *user* document edits — remote merges and presence
        // are handled separately so we don't feed changes back in a loop.
        { source: "user", scope: "document" }
      );
      unsubs.push(storeListener);
    };

    // ----- Yjs -> local store -------------------------------------------
    const handleYjsChange = () => {
      const observer = (
        _events: Y.YEvent<Y.Map<TLRecord>>[],
        transaction: Y.Transaction
      ) => {
        // Skip our own writes (they originated from handleStoreChange).
        if (transaction.local) return;
        const toPut: TLRecord[] = [];
        const toRemove: TLRecord["id"][] = [];
        // Recompute from the authoritative map. We diff against the store
        // by simply re-applying the current map state for changed keys.
        _events.forEach((event) => {
          event.changes.keys.forEach((change, key) => {
            if (change.action === "delete") {
              toRemove.push(key as TLRecord["id"]);
            } else {
              const record = yRecords.get(key);
              if (record) toPut.push(record);
            }
          });
        });
        store.mergeRemoteChanges(() => {
          if (toRemove.length) store.remove(toRemove);
          if (toPut.length) store.put(toPut);
        });
      };
      yRecords.observeDeep(observer as never);
      unsubs.push(() => yRecords.unobserveDeep(observer as never));
    };

    // ----- Presence (live cursors) --------------------------------------
    const handlePresence = () => {
      if (!awareness) return;
      try {
        // ``createPresenceStateDerivation`` wants a ``Signal<TLUser>`` (a
        // record), not a bare prefs object — so we mint one via
        // ``UserRecordType.create`` from the collab token's identity,
        // falling back to tldraw's local prefs.
        const $user = computed<TLUser>("user", () => {
          const prefs = getUserPreferences();
          return UserRecordType.create({
            id: UserRecordType.createId(user?.id ?? prefs.id),
            name: user?.name ?? prefs.name ?? "Anonymous",
            color: user?.color ?? prefs.color ?? "#4285f4",
          });
        });

        // tldraw keys presence records by a per-client instance id derived
        // from the awareness clientID so each tab/user gets one cursor.
        const presenceId = InstancePresenceRecordType.createId(
          String(awareness.clientID)
        );
        const presenceDerivation = createPresenceStateDerivation($user, {
          instanceId: presenceId,
        })(store);

        // Push local presence to awareness whenever it changes.
        const stopPushing = react("push presence", () => {
          const presence = presenceDerivation.get();
          requestAnimationFrame(() => {
            awareness.setLocalStateField("presence", presence);
          });
        });
        unsubs.push(stopPushing);

        // Mirror remote awareness states into the store as presence records.
        const handleAwarenessUpdate = (update: {
          added: number[];
          updated: number[];
          removed: number[];
        }) => {
          const states = awareness.getStates() as Map<
            number,
            { presence?: TLInstancePresence }
          >;
          const toPut: TLInstancePresence[] = [];
          const toRemove: TLInstancePresence["id"][] = [];

          for (const clientId of [...update.added, ...update.updated]) {
            if (clientId === awareness.clientID) continue;
            const state = states.get(clientId);
            if (state?.presence) toPut.push(state.presence);
          }
          for (const clientId of update.removed) {
            toRemove.push(
              InstancePresenceRecordType.createId(String(clientId))
            );
          }
          store.mergeRemoteChanges(() => {
            if (toRemove.length) store.remove(toRemove);
            if (toPut.length) store.put(toPut);
          });
        };
        awareness.on("update", handleAwarenessUpdate);
        unsubs.push(() => awareness.off("update", handleAwarenessUpdate));
      } catch (err) {
        // Presence is best-effort — never let it break document sync.
        // eslint-disable-next-line no-console
        console.warn("Canvas presence wiring failed; cursors degraded.", err);
      }
    };

    // ----- Initial sync: seed store from Yjs (or Yjs from store) ---------
    const syncStoreAndYjs = () => {
      const records = [...yRecords.values()];
      if (records.length) {
        // Existing board — replace the store's defaults with the shared
        // doc's records so both clients converge on the same content.
        transact(() => {
          store.clear();
          store.put(records);
        });
      } else {
        // Brand-new board — push the store's *default* records (document,
        // page, etc.) into Yjs so the next client to join sees a populated
        // map. Don't clear first: that would wipe the very records we seed.
        ydoc.transact(() => {
          for (const record of store.allRecords()) {
            yRecords.set(record.id, record);
          }
        });
      }

      handleStoreChange();
      handleYjsChange();
      handlePresence();

      setStoreWithStatus({
        store,
        status: "synced-remote",
        connectionStatus: "online",
      });
    };

    // Hocuspocus has its own "synced" lifecycle; the Y.Doc is usable
    // immediately (it syncs deltas under the hood), so we wire up now and
    // let the observer apply server state as it arrives.
    if (provider.isSynced) {
      syncStoreAndYjs();
    } else {
      const onSynced = () => {
        provider.off("synced", onSynced);
        syncStoreAndYjs();
      };
      provider.on("synced", onSynced);
      unsubs.push(() => provider.off("synced", onSynced));
    }

    return () => {
      unsubs.forEach((fn) => {
        try {
          fn();
        } catch {
          /* best-effort teardown */
        }
      });
      setStoreWithStatus({ status: "loading" });
    };
  }, [ydoc, provider, user?.id, user?.name, user?.color]);

  return storeWithStatus;
}
