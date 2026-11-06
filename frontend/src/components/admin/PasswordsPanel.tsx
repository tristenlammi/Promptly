import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";

import { apiClient } from "@/api/client";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { SettingsCard } from "./SettingsCard";

type Policy = {
  enabled: boolean;
  preview_badge: boolean;
  min_kdf_m: number;
  min_kdf_t: number;
  max_attachment_mb: number;
  breach_check: boolean;
};

const KEY = ["passwords", "policy"];

/**
 * Policy for Passwords, and nothing else. Vaults are end-to-end encrypted, so nobody
 * here can read one or get someone back into theirs. They can only be destroyed.
 */
export function PasswordsPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async () => (await apiClient.get<Policy>("/passwords/admin/policy")).data,
  });
  const patch = useMutation({
    mutationFn: async (body: Partial<Policy>) => (await apiClient.patch<Policy>("/passwords/admin/policy", body)).data,
    onSuccess: (row) => qc.setQueryData(KEY, row),
    onError: (e) => toast.error(apiErrorMessage(e)),
  });
  if (!data) return null;

  const box = (key: "enabled" | "preview_badge" | "breach_check", label: string, hint: string) => (
    <label className="flex items-start gap-2 text-sm text-[var(--text)]">
      <input type="checkbox" className="mt-0.5" checked={data[key]} onChange={(e) => patch.mutate({ [key]: e.target.checked })} />
      <span>
        {label}
        <span className="block text-xs text-[var(--text-muted)]">{hint}</span>
      </span>
    </label>
  );

  return (
    <SettingsCard title="Passwords" icon={<KeyRound className="h-4 w-4" />}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-[var(--text-muted)]">
          You can't read anyone's vault from here, and you can't get anyone back into theirs if they lose both their master password and their recovery kit.
        </p>
        {box("enabled", "Passwords is on", "Off hides it and refuses all vault requests. Nothing is deleted.")}
        {box(
          "preview_badge",
          "Show the Preview warning",
          "This build has had automated tests and AI-assisted review, not an independent security audit. Turn this off only once you've decided you're happy with that.",
        )}
        {box("breach_check", "Allow breach checks", "Clients send the first five characters of a password's hash through this server to the breach service. The service sees this server's address.")}
        <label className="flex flex-col gap-1 text-sm text-[var(--text)]">
          Largest attachment, in MB
          <input
            className="w-32 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
            type="number"
            min={1}
            max={100000}
            defaultValue={data.max_attachment_mb}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n !== data.max_attachment_mb) patch.mutate({ max_attachment_mb: n });
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-[var(--text)]">
          Lowest key-stretching memory new vaults can use, in MiB
          <input
            className="w-32 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1"
            type="number"
            min={64}
            max={4096}
            defaultValue={Math.round(data.min_kdf_m / 1024)}
            onBlur={(e) => {
              const n = Number(e.target.value) * 1024;
              if (Number.isInteger(n) && n >= 65536 && n !== data.min_kdf_m) patch.mutate({ min_kdf_m: n });
            }}
          />
          <span className="text-xs text-[var(--text-muted)]">Going higher slows unlocking on older phones.</span>
        </label>
      </div>
    </SettingsCard>
  );
}
