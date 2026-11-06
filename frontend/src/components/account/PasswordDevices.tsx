import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, X } from "lucide-react";

import { apiClient } from "@/api/client";
import { formatRelativeTime } from "@/components/files/helpers";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

type PasswordDevice = { id: string; name: string; platform: string; scopes: string[]; last_seen_at: string | null; created_at: string };

const KEY = ["passwords", "devices"];

/** Which devices can reach your password vault. Nothing here reads the vault itself. */
export function PasswordDevices() {
  const qc = useQueryClient();
  const { data: devices = [] } = useQuery({
    queryKey: KEY,
    queryFn: async () => (await apiClient.get<PasswordDevice[]>("/passwords/devices")).data,
    retry: false,
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`/passwords/devices/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (e) => toast.error(apiErrorMessage(e)),
  });
  if (!devices.length) return null;
  return (
    <section aria-label="Password vault devices" className="mt-4 rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        <KeyRound className="h-4 w-4" /> Password vault devices
      </h2>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Browsers and apps connected to Passwords. Cutting one off stops it syncing. What it already has stays encrypted on it, locked by your master password.
      </p>
      <ul className="flex flex-col gap-2">
        {devices.map((d) => (
          <li key={d.id} className="flex items-center gap-2 text-sm text-[var(--text)]">
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <span className="text-xs text-[var(--text-muted)]">{d.last_seen_at ? formatRelativeTime(d.last_seen_at) : "not used yet"}</span>
            <button
              type="button"
              aria-label={`Cut off ${d.name}`}
              className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--danger)]"
              onClick={async () => {
                if (await confirm({ title: `Cut off ${d.name}?`, message: "It stops syncing with your vault straight away.", confirmLabel: "Cut off", danger: true })) revoke.mutate(d.id);
              }}
            >
              <X className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
