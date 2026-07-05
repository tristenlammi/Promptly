import { useEffect, useState } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";

import { UserAvatar } from "@/components/shared/UserAvatar";

/**
 * Presence, made visible (review item 1.7): a small overlapping row of
 * avatars for everyone else in this item's collab room, read straight
 * from the provider's awareness channel — the same channel the live
 * cursors already ride, so there's no extra backend surface.
 *
 * Notes had collaborator chips inside the editor chrome; this brings the
 * same signal to canvas / sheet pane headers via the ``status`` slot.
 */
interface Peer {
  clientId: number;
  name: string;
  color: string;
  avatar: string | null;
}

export function usePresencePeers(provider: HocuspocusProvider | null): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness) {
      setPeers([]);
      return;
    }
    const update = () => {
      const out: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const u = (state as {
          user?: {
            name?: string;
            color?: string;
            avatar?: string | null;
          };
        }).user;
        out.push({
          clientId,
          name: u?.name ?? "Anonymous",
          color: u?.color ?? "#D97757",
          avatar: u?.avatar ?? null,
        });
      });
      setPeers(out);
    };
    awareness.on("change", update);
    update();
    return () => {
      awareness.off("change", update);
      setPeers([]);
    };
  }, [provider]);
  return peers;
}

export function PresenceChips({
  peers,
  max = 4,
}: {
  peers: Array<{
    clientId?: number;
    id?: string;
    name: string;
    color: string;
    avatar: string | null;
  }>;
  max?: number;
}) {
  if (peers.length === 0) return null;
  return (
    <span
      className="inline-flex items-center -space-x-1.5"
      title={`Also here: ${peers.map((p) => p.name).join(", ")}`}
    >
      {peers.slice(0, max).map((p, i) => (
        <UserAvatar
          key={p.clientId ?? p.id ?? i}
          name={p.name}
          avatarUrl={p.avatar}
          color={p.color}
          size={20}
          className="border-2 border-[var(--surface)]"
        />
      ))}
      {peers.length > max && (
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-[var(--surface)] bg-neutral-500 text-[9px] font-semibold text-white">
          +{peers.length - max}
        </span>
      )}
    </span>
  );
}
