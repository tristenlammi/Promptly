import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { apiClient } from "@/api/client";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

type BreachAdmin = {
  key_set: boolean;
  rpm: number;
  plan: string | null;
  last_run_at: string | null;
  last_error: string | null;
  people_on: number;
};

const KEY = ["passwords", "breach-watch"];

/**
 * The Have I Been Pwned key for breach alerts. Stored encrypted like the SMTP password,
 * and never shown again once saved. Each person still turns alerts on for themselves.
 */
export function PasswordsBreachSettings() {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async () => (await apiClient.get<BreachAdmin>("/passwords/admin/breach-watch")).data,
  });
  const save = useMutation({
    mutationFn: async (body: { api_key?: string; rpm?: number }) => (await apiClient.put<BreachAdmin>("/passwords/admin/breach-watch", body)).data,
    onSuccess: (row) => {
      qc.setQueryData(KEY, row);
      setKey("");
      toast.success("Saved");
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });
  if (!data) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3 text-sm text-[var(--text)]" data-testid="breach-admin">
      <span className="font-medium">Breach alerts for email addresses</span>
      <p className="text-xs text-[var(--text-muted)]">
        Uses a{" "}
        <a className="text-[var(--accent)] underline" href="https://haveibeenpwned.com/API/Key" target="_blank" rel="noreferrer">Have I Been Pwned API key</a>, which you buy. The smallest plan allows 10 checks a minute, enough for hundreds of people. People turn alerts on for themselves; then this server sends their account and Mail addresses to Have I Been Pwned about once a day. With no key, nothing is sent.
      </p>
      {data.key_set ? (
        <p className="text-xs">
          Key saved{data.plan ? ` (${data.plan})` : ""}. {data.people_on} {data.people_on === 1 ? "person has" : "people have"} alerts on.
          {data.last_run_at ? ` Last run ${new Date(data.last_run_at).toLocaleString()}.` : ""}
        </p>
      ) : (
        <p className="text-xs">No key: breach alerts are off.</p>
      )}
      {data.last_error && <p className="text-xs text-[var(--danger)]">{data.last_error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Have I Been Pwned API key"
          className="w-80 max-w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 font-mono"
          type="password"
          autoComplete="off"
          placeholder={data.key_set ? "Replace the key" : "32-character key"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button
          type="button"
          className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium hover:bg-[var(--surface-1)] disabled:opacity-50"
          disabled={!key.trim() || save.isPending}
          onClick={() => save.mutate({ api_key: key.trim() })}
        >
          Save key
        </button>
        {data.key_set && (
          <button
            type="button"
            className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-medium hover:bg-[var(--surface-1)]"
            onClick={() => save.mutate({ api_key: "" })}
          >
            Remove key
          </button>
        )}
      </div>
      <label className="flex flex-col gap-1">
        Checks a minute your plan allows
        <input
          className="w-32 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
          type="number"
          min={1}
          max={100000}
          defaultValue={data.rpm}
          key={data.rpm}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= 1 && n !== data.rpm) save.mutate({ rpm: n });
          }}
        />
        <span className="text-xs text-[var(--text-muted)]">Read from Have I Been Pwned when you save the key. The server stays a little under it.</span>
      </label>
    </div>
  );
}
