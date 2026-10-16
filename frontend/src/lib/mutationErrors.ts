import type { Mutation } from "@tanstack/react-query";

import { lastErrorToast, toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** The global safety net for failed actions (R-092).
 *
 *  Skipped when the mutation handles its own errors (``onError``) or opts
 *  out (``meta: { silent: true }``). A caller using ``mutateAsync`` may
 *  catch the error and show its own message, which this can't see — so it
 *  waits a moment and stays quiet if any error toast went up meanwhile.
 *  Expired sessions are left to the sign-in flow. */
export function reportUnhandledMutationError(
  error: unknown,
  mutation: Mutation<unknown, unknown, unknown, unknown>
): void {
  if (mutation.options.onError || mutation.meta?.silent) return;
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 401) return;
  if ((error as { name?: string })?.name === "CanceledError") return;
  const failedAt = Date.now();
  window.setTimeout(() => {
    if (lastErrorToast() >= failedAt) return;
    toast.error(apiErrorMessage(error, "That didn't work. Try again."));
  }, 150);
}
