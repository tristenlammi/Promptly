import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { SettingsCard } from "@/components/admin/SettingsCard";
import { notesApi } from "@/notes/api";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { mailApi } from "./api";

interface Status {
  ready: boolean;
  on: boolean;
  local: boolean;
  provider: string;
  model: string;
  indexed: number;
  total: number;
}

/**
 * AI search: the admin's choice, for everyone on this Promptly. Mail and
 * Notes each have their own switch (notes are more personal than mail),
 * with the same rule: on for an indexer on this network, off for a cloud
 * one until the admin agrees. Only totals are shown, never anyone's items.
 */
export function AiSearchCard() {
  const qc = useQueryClient();
  const mail = useQuery({
    queryKey: ["mail-ai-search"],
    queryFn: mailApi.aiSearch,
    refetchInterval: (q) => (q.state.data?.on && q.state.data.indexed < q.state.data.total ? 10_000 : false),
  });
  const notes = useQuery({
    queryKey: ["notes-ai-search"],
    queryFn: notesApi.aiSearch,
    refetchInterval: (q) => (q.state.data?.on && q.state.data.indexed < q.state.data.total ? 10_000 : false),
  });
  const setMail = useMutation({
    mutationFn: mailApi.setAiSearch,
    onSuccess: (next) => qc.setQueryData(["mail-ai-search"], next),
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't change that.")),
  });
  const setNotes = useMutation({
    mutationFn: notesApi.setAiSearch,
    onSuccess: (next) => {
      qc.setQueryData(["notes-ai-search"], next);
      void qc.invalidateQueries({ queryKey: ["notes-my-search"] });
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't change that.")),
  });
  const any = mail.data ?? notes.data;
  if (!any) return null;
  return (
    <SettingsCard title="AI search" icon={<Search className="h-4 w-4" />}>
      {!any.ready ? (
        <p className="text-sm text-[var(--text-muted)]">Choose an embedding model above first. Until then, mail and notes search look for the exact words.</p>
      ) : (
        <div className="space-y-5 text-sm">
          <p className="text-xs text-[var(--text-muted)]">
            Finds email and notes by what they mean, not only the words in them. The embedding model ({any.model}){" "}
            {any.local ? "runs on your own network, so nothing leaves it." : `is ${any.provider}, a cloud service.`}
          </p>
          {mail.data && (
            <Row
              data={mail.data}
              label="Mail"
              noun="emails"
              pending={setMail.isPending}
              onChange={(on) => setMail.mutate(on)}
              cloud="Turning this on sends the text of everyone's email, including people they correspond with, to that service."
            />
          )}
          {notes.data && (
            <Row
              data={notes.data}
              label="Notes"
              noun="notes"
              pending={setNotes.isPending}
              onChange={(on) => setNotes.mutate(on)}
              cloud="Turning this on sends the words of people's notes to that service. Each person can still keep their own notes out in Notes → Settings."
              extra="Each person can turn it off for their own notes. Search in Ctrl+K stays words only."
            />
          )}
        </div>
      )}
    </SettingsCard>
  );
}

function Row({ data, label, noun, pending, onChange, cloud, extra }: { data: Status; label: string; noun: string; pending: boolean; onChange: (on: boolean) => void; cloud: string; extra?: string }) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-start gap-3 text-[var(--text)]">
        <input type="checkbox" checked={data.on} disabled={pending} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
        <span>
          {label}: find {noun} by what they mean, for everyone on this Promptly
          <span className="mt-1 block text-xs text-[var(--text-muted)]">
            {data.local
              ? "It's on unless you turn it off."
              : `${cloud} It stays off until you choose otherwise, and goes back off if you change the embedding model's provider.`}
            {extra ? ` ${extra}` : ""}
          </span>
        </span>
      </label>
      <p className="pl-7 text-xs text-[var(--text-muted)]">
        {data.on
          ? data.indexed < data.total
            ? `Indexed ${data.indexed} of ${data.total} ${noun} so far.`
            : `All ${data.total} ${noun} are indexed.`
          : "Off: search looks for the exact words and nothing is sent to the model. Turning it off removes what was indexed."}
      </p>
    </div>
  );
}
