/**
 * A space's own emoji. Written ``:name:`` in a message or as a reaction;
 * drawn as its picture wherever the room's space has an emoji by that name,
 * and left as the plain text everywhere else (a conversation, another
 * space, or after the emoji was deleted).
 *
 * ``RoomView`` wraps a room in the provider; everything inside (messages,
 * reactions, the emoji picker) reads it with ``useCustomEmoji``.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { Space, SpaceEmoji } from "@/api/rooms";

interface CustomEmoji {
  /** name → emoji, for this room's space. */
  byName: Record<string, SpaceEmoji>;
  list: SpaceEmoji[];
  /** The picker's heading for them. */
  spaceName: string | null;
}

const NONE: CustomEmoji = { byName: {}, list: [], spaceName: null };
const Ctx = createContext<CustomEmoji>(NONE);

export function CustomEmojiProvider({ space, children }: { space: Pick<Space, "name" | "emojis"> | null; children: ReactNode }) {
  const emojis = space?.emojis;
  const name = space?.name ?? null;
  const value = useMemo<CustomEmoji>(() => {
    if (!emojis?.length) return NONE;
    const byName: Record<string, SpaceEmoji> = {};
    for (const e of emojis) byName[e.name] = e;
    return { byName, list: emojis, spaceName: name };
  }, [emojis, name]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCustomEmoji(): CustomEmoji {
  return useContext(Ctx);
}

const CODE = /^:([a-z0-9_]{2,30}):$/;

/** ``party`` from ``:party:``, or null when it isn't written that way. */
export function customName(e: string): string | null {
  return CODE.exec(e)?.[1] ?? null;
}

/** An emoji as it should look: a custom one as its picture, any other as
 *  itself. Sized by the text around it. */
export function EmojiGlyph({ e, className }: { e: string; className?: string }) {
  const { byName } = useCustomEmoji();
  const name = customName(e);
  const found = name ? byName[name] : undefined;
  if (!found) return <>{e}</>;
  return <img src={found.url} alt={e} title={e} draggable={false} className={className ?? "inline-block h-[1.3em] w-[1.3em] object-contain align-[-0.25em]"} />;
}

/** Markdown for a message: each known ``:name:`` outside code becomes an
 *  image the message renderer draws as the emoji (``emoji:name``). */
export function markCustomEmoji(text: string, byName: Record<string, SpaceEmoji>): string {
  if (!text.includes(":") || Object.keys(byName).length === 0) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`|!?\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)/g)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(/:([a-z0-9_]{2,30}):/g, (whole, name: string) => (byName[name] ? `![:${name}:](emoji:${name})` : whole)),
    )
    .join("");
}
