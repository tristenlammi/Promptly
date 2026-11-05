import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";

import { SettingsCard } from "@/components/admin/SettingsCard";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { mailApi } from "./api";

/** AI search for mail: the admin's choice, for everyone on this Promptly. */
export function MailSearchCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["mail-ai-search"],
    queryFn: mailApi.aiSearch,
    refetchInterval: (q) => (q.state.data?.on && q.state.data.indexed < q.state.data.total ? 10_000 : false),
  });
  const change = useMutation({
    mutationFn: mailApi.setAiSearch,
    onSuccess: (next) => qc.setQueryData(["mail-ai-search"], next),
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't change that.")),
  });
  if (!data) return null;
  const where = data.local ? "runs on your own network, so email stays here" : `is ${data.provider}, a cloud service`;
  return (
    <SettingsCard title="AI search for mail" icon={<Mail className="h-4 w-4" />}>
      {!data.ready ? (
        <p className="text-sm text-[var(--text-muted)]">Choose an embedding model above first. Until then, mail search looks for the exact words.</p>
      ) : (
        <div className="space-y-3 text-sm">
          <label className="flex items-start gap-3 text-[var(--text)]">
            <input type="checkbox" checked={data.on} disabled={change.isPending} onChange={(e) => change.mutate(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
            <span>
              Find email by what it means, for everyone on this Promptly
              <span className="mt-1 block text-xs text-[var(--text-muted)]">
                The embedding model ({data.model}) {where}.{" "}
                {data.local ? "It's on unless you turn it off." : "Turning this on sends the text of everyone's email, including people they correspond with, to that service. It stays off until you choose otherwise, and goes back off if you change the embedding model's provider."}
              </span>
            </span>
          </label>
          {data.on && <p className="text-xs text-[var(--text-muted)]">{data.indexed < data.total ? `Indexed ${data.indexed} of ${data.total} emails so far.` : `All ${data.total} emails are indexed.`}</p>}
          {!data.on && <p className="text-xs text-[var(--text-muted)]">While it's off, search looks for the exact words and nothing is sent to the model. Turning it off removes what was indexed.</p>}
        </div>
      )}
    </SettingsCard>
  );
}
