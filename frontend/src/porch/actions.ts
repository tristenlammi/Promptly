/**
 * Group actions shared by every screen that shows a group (the feed's chips,
 * the Groups tab, a group's page, the welcome sheet, invites): each updates
 * the caches, says what happened in plain words, and says why when it can't.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { porchApi, type Bootstrap, type PorchGroup } from "@/api/porch";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { BOOTSTRAP_KEY, groupKey, groupsChanged, updateBootstrap } from "./cache";

// Debounced tick saves: quick taps on one chip send only the last state.
const tickTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function useGroupActions() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const fail = (err: unknown, fallback: string) => toast.error(apiErrorMessage(err, fallback));

  /** Tick or untick groups in your feed: shown at once, saved just after. */
  const setTicks = (changes: Record<string, boolean>) => {
    const before = qc.getQueryData<Bootstrap>(BOOTSTRAP_KEY);
    updateBootstrap(qc, (b) => ({ ...b, groups: b.groups.map((g) => (g.id in changes ? { ...g, in_feed: changes[g.id] } : g)) }));
    for (const [id, inFeed] of Object.entries(changes)) {
      const t = tickTimers.get(id);
      if (t) clearTimeout(t);
      tickTimers.set(
        id,
        setTimeout(() => {
          tickTimers.delete(id);
          porchApi.setMine(id, { in_feed: inFeed }).catch((err) => {
            const was = before?.groups.find((g) => g.id === id)?.in_feed ?? true;
            updateBootstrap(qc, (b) => ({ ...b, groups: b.groups.map((g) => (g.id === id ? { ...g, in_feed: was } : g)) }));
            fail(err, "Couldn't save your feed. Try again.");
          });
        }, 350),
      );
    }
  };

  const join = async (g: Pick<PorchGroup, "id" | "name">, { open = false } = {}) => {
    try {
      await porchApi.join(g.id);
      groupsChanged(qc, g.id);
      toast.success(`You're in ${g.name}. Its posts are in your feed.`);
      if (open) navigate(`/porch/g/${g.id}`);
      return true;
    } catch (err) {
      fail(err, "Couldn't join the group. Try again.");
      return false;
    }
  };

  const accept = async (g: Pick<PorchGroup, "id" | "name">) => {
    try {
      await porchApi.accept(g.id);
      groupsChanged(qc, g.id);
      toast.success(`You're in ${g.name}. Its posts are in your feed.`);
      return true;
    } catch (err) {
      fail(err, "Couldn't join the group. Try again.");
      groupsChanged(qc, g.id);
      return false;
    }
  };

  const decline = async (g: Pick<PorchGroup, "id" | "name">) => {
    try {
      await porchApi.decline(g.id);
      updateBootstrap(qc, (b) => ({ ...b, invites: b.invites.filter((i) => i.id !== g.id) }));
      groupsChanged(qc, g.id);
      return true;
    } catch (err) {
      fail(err, "Couldn't answer the invite. Try again.");
      return false;
    }
  };

  const leave = async (g: PorchGroup, meId: string) => {
    if (g.is_owner) {
      toast.info("Make someone else the owner before you leave.");
      return false;
    }
    const ok = await confirm({
      title: `Leave ${g.name}?`,
      message:
        g.visibility === "private"
          ? "You'll stop seeing its posts. Your own posts there stay. To come back, someone in it will have to invite you."
          : "You'll stop seeing its posts. Your own posts there stay. You can join again from Find groups.",
      confirmLabel: "Leave group",
      danger: true,
    });
    if (!ok) return false;
    try {
      await porchApi.removeMember(g.id, meId);
      qc.removeQueries({ queryKey: groupKey(g.id) });
      groupsChanged(qc, g.id);
      toast.success(`You left ${g.name}.`);
      navigate("/porch/groups");
      return true;
    } catch (err) {
      fail(err, "Couldn't leave the group. Try again.");
      return false;
    }
  };

  const remove = async (g: PorchGroup) => {
    const ok = await confirm({
      title: `Delete ${g.name}?`,
      message: `Posts only in ${g.name} will be seen by their authors alone. Posts also in other groups stay there. This can't be undone.`,
      confirmLabel: "Delete group",
      danger: true,
    });
    if (!ok) return false;
    try {
      await porchApi.deleteGroup(g.id);
      qc.removeQueries({ queryKey: groupKey(g.id) });
      groupsChanged(qc, g.id);
      toast.success(`${g.name} was deleted.`);
      navigate("/porch/groups");
      return true;
    } catch (err) {
      fail(err, "Couldn't delete the group. Try again.");
      return false;
    }
  };

  return { setTicks, join, accept, decline, leave, remove, fail };
}

/** Block someone: you vanish from each other everywhere in Porch. */
export function useBlock() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async (user: { id: string; name: string }, { leave = false } = {}) => {
    const ok = await confirm({
      title: `Block ${user.name}?`,
      message: `You won't see each other's posts anywhere in Porch, even in groups you share, and neither of you can message the other one-to-one. ${user.name} isn't told. You can unblock them in Account → Blocked people.`,
      confirmLabel: "Block",
      danger: true,
    });
    if (!ok) return false;
    try {
      await porchApi.block(user.id);
      void qc.invalidateQueries({ queryKey: ["porch"] });
      toast.success(`${user.name} is blocked.`);
      if (leave) navigate("/porch/");
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't block them. Try again."));
      return false;
    }
  };
}
