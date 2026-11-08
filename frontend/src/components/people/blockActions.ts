import type { QueryClient } from "@tanstack/react-query";

import { BLOCKED_KEY, peopleHubApi } from "@/api/peopleHub";
import { confirm } from "@/components/shared/ConfirmDialog";
import { BOOTSTRAP_KEY } from "@/rooms/cache";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * Block and Unblock, shared by the Rooms conversation header, the person
 * page and Account → Blocked people (``/api/people/blocks``). A block is
 * private: the other person isn't told.
 */

function refresh(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: BLOCKED_KEY });
  void qc.invalidateQueries({ queryKey: ["people-hub"] });
  void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
}

/** Ask, then block. True when they're now blocked. */
export async function blockPerson(qc: QueryClient, person: { id: string; username: string }): Promise<boolean> {
  const name = person.username;
  const ok = await confirm({
    title: `Block ${name}?`,
    message: `You won't be able to message each other one-to-one, and you won't get notifications about what ${name} does. You'll both stay in any spaces and group conversations you share. ${name} won't be told, and you can unblock them any time.`,
    confirmLabel: "Block",
    danger: true,
  });
  if (!ok) return false;
  try {
    await peopleHubApi.block(person.id);
    toast.success(`${name} is blocked.`);
    refresh(qc);
    return true;
  } catch (e) {
    toast.error(apiErrorMessage(e, "Couldn't block them."));
    return false;
  }
}

/** Unblock straight away (nothing is lost by undoing it). */
export async function unblockPerson(qc: QueryClient, person: { id: string; username: string }): Promise<boolean> {
  try {
    await peopleHubApi.unblock(person.id);
    toast.success(`Unblocked. You and ${person.username} can message each other again.`);
    refresh(qc);
    return true;
  } catch (e) {
    toast.error(apiErrorMessage(e, "Couldn't unblock them."));
    return false;
  }
}
