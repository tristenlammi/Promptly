/**
 * Reacting, saving and voting on a post: shown at once (optimistic), then
 * replaced by what the server says; put back with a plain message when it
 * fails.
 */
import { useQueryClient } from "@tanstack/react-query";

import { porchApi, type PorchPost, type Reactions } from "@/api/porch";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { cachedPost, patchPost, putPost, savedKey } from "./cache";

/** Your reaction changed, until the server's answer: yours set, and its
 *  emoji in the row (whether anyone else still uses the old one only the
 *  server knows). */
function withMine(r: Reactions, emoji: string | null): Reactions {
  const emojis = emoji && !r.emojis.includes(emoji) ? [...r.emojis, emoji] : r.emojis;
  return { ...r, emojis, mine: emoji };
}

export function usePostTalk() {
  const qc = useQueryClient();

  const react = async (post: PorchPost, emoji: string | null) => {
    const before = cachedPost(qc, post.id)?.reactions ?? post.reactions;
    patchPost(qc, post.id, (p) => ({ ...p, reactions: withMine(p.reactions, emoji) }));
    try {
      const r = await porchApi.react(post.id, emoji);
      patchPost(qc, post.id, (p) => ({ ...p, reactions: r }));
    } catch (err) {
      patchPost(qc, post.id, (p) => ({ ...p, reactions: before }));
      toast.error(apiErrorMessage(err, "Couldn't react. Try again."));
    }
  };

  const save = async (post: PorchPost, saved: boolean) => {
    patchPost(qc, post.id, (p) => ({ ...p, saved }));
    try {
      await porchApi.setSaved(post.id, saved);
      void qc.invalidateQueries({ queryKey: savedKey });
      toast.success(saved ? "Saved. Find it under Saved." : "Taken out of Saved.");
    } catch (err) {
      patchPost(qc, post.id, (p) => ({ ...p, saved: !saved }));
      toast.error(apiErrorMessage(err, "Couldn't save the post. Try again."));
    }
  };

  const vote = async (post: PorchPost, optionId: string | null) => {
    try {
      putPost(qc, post.id, await porchApi.vote(post.id, optionId));
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't vote. Try again."));
    }
  };

  return { react, save, vote };
}
