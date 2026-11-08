// Mail sent to one of your aliases (Passwords → Aliases): which alias, which login,
// a warning when a sender doesn't fit, and replying from the alias.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, AtSign } from "lucide-react";

import { apiClient } from "@/api/client";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import type { ThreadAlias, ThreadAliases } from "./aliasReply";

export { replyAlias, sendAsNote } from "./aliasReply";
export type { ThreadAlias, ThreadAliases } from "./aliasReply";

export const aliasMailApi = {
  async thread(accountId: string, key: string) {
    return (await apiClient.get<ThreadAliases>(`/mail/aliases/thread/${accountId}/${key}`)).data;
  },
  async setEnabled(id: string, enabled: boolean) {
    return (await apiClient.patch<ThreadAlias>(`/mail/aliases/${id}`, { enabled })).data;
  },
};

export function useThreadAliases(accountId: string, key: string) {
  return useQuery({ queryKey: ["mail-thread-aliases", accountId, key], queryFn: () => aliasMailApi.thread(accountId, key), staleTime: 60_000 }).data;
}

function day(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" }) : "never";
}

export function AliasNotes({ info, accountId, threadKey }: { info: ThreadAliases | undefined; accountId: string; threadKey: string }) {
  const qc = useQueryClient();
  const list = Object.values(info?.aliases ?? {});
  if (!list.length) return null;
  const toggle = async (a: ThreadAlias) => {
    try {
      await aliasMailApi.setEnabled(a.id, !a.enabled);
      toast.success(a.enabled ? "Turned off. Its new mail goes to Trash, or the folder you chose." : "Turned back on.");
      void qc.invalidateQueries({ queryKey: ["mail-thread-aliases", accountId, threadKey] });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't change that alias."));
    }
  };
  return (
    <div className="space-y-1.5">
      {list.map((a) => (
        <div key={a.id} data-testid="mail-alias" className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs text-[var(--text)]">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <AtSign className="h-3.5 w-3.5 shrink-0 text-[#D97757]" />
            <span>Sent to your alias <span className="font-mono">{a.address}</span>{a.enabled ? "" : " (off)"}</span>
            <span className="text-[var(--text-muted)]">
              {a.item_id ? <a className="underline" href={`/passwords/#/item/${a.item_id}`}>for a login in Passwords</a> : "not linked to a login"} · {a.count === 1 ? "1 email" : `${a.count} emails`}, last {day(a.last_at)}
            </span>
            <button type="button" onClick={() => void toggle(a)} className="ml-auto font-medium text-[#D97757]">{a.enabled ? "Turn off" : "Turn on"}</button>
          </p>
          {a.send_as === "refused" && (
            <p className="mt-1 text-[var(--text-muted)]">Replies go from your mailbox's own address, because your provider won't send as {a.domain}. {a.send_as_text}</p>
          )}
          {a.flagged_sender && (
            <p className="mt-1 flex gap-1.5 text-[#C9A227]">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>This alias got mail from {a.flagged_sender}, which doesn't look like who it was for. It may have been sold or leaked. Check it in Passwords → Aliases.</span>
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** In the composer: send as the alias, or as the mailbox itself. */
export function FromAliasRow({ alias, accountEmail, value, onChange }: { alias: string; accountEmail: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
      <span className="w-8 shrink-0">From</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Send from" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-[var(--text)] outline-none">
        <option value={alias}>{alias} (alias)</option>
        <option value="">{accountEmail}</option>
      </select>
    </label>
  );
}
