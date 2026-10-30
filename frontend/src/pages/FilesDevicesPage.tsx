import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plus, RefreshCw, Smartphone } from "lucide-react";
import { Link } from "react-router-dom";

import { appPasswordsApi } from "@/api/appPasswords";
import { devicesApi, type PairStart } from "@/api/devices";
import { formatRelativeTime } from "@/components/files/helpers";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Modal } from "@/components/shared/Modal";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * Files → Devices: link a phone with PromptlySync. "Add device" shows a QR
 * code — the phone's camera opens the download page, and the app scans
 * the same code to sign in. Each phone gets its own app password (upload
 * and read, never delete), so it can be cut off on its own.
 */

const KEY = ["app-passwords"];

export function FilesDevicesPage() {
  const qc = useQueryClient();
  const { data: devices = [], isLoading } = useQuery({ queryKey: KEY, queryFn: appPasswordsApi.list });
  const [adding, setAdding] = useState(false);

  const revoke = async (id: string, label: string) => {
    const ok = await confirm({
      title: `Remove “${label}”?`,
      message: "It stops syncing at once. Photos it already sent stay in Photos.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await appPasswordsApi.revoke(id);
      toast.success(`“${label}” is no longer linked.`);
      void qc.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't remove it."));
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <div className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-[var(--text)]">Devices</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Back up your phone's photos and videos to Photos with the PromptlySync app.
          </p>
        </div>
        <Button variant="primary" size="sm" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
          Add device
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading…</p>
      ) : devices.length === 0 ? (
        <div className="rounded-card border border-dashed border-[var(--border)] px-6 py-10 text-center">
          <Smartphone className="mx-auto mb-2 h-8 w-8 text-[var(--text-muted)]" />
          <p className="text-sm font-medium text-[var(--text)]">No devices yet</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-[var(--text-muted)]">
            Add your phone and choose which of its folders to back up. Deleting a photo on the phone to free up space
            keeps it here.
          </p>
          <Button className="mt-4" variant="secondary" size="sm" onClick={() => setAdding(true)}>
            Add device
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-3">
              <Smartphone className="h-5 w-5 shrink-0 text-[var(--text-muted)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--text)]">{d.name}</div>
                <div className="truncate text-xs text-[var(--text-muted)]">
                  Added {formatRelativeTime(d.created_at)} ·{" "}
                  {d.last_used_at ? `last synced ${formatRelativeTime(d.last_used_at)}` : "not synced yet"}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void revoke(d.id, d.name)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-xs text-[var(--text-muted)]">
        Using another app (FolderSync, rclone, Finder)? Make it a password in{" "}
        <Link to="/account/devices" className="text-[var(--accent-text)] hover:underline">
          Account → Devices
        </Link>
        .
      </p>

      {adding && (
        <AddDevice
          onClose={() => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: KEY });
          }}
        />
      )}
    </div>
  );
}

function AddDevice({ onClose }: { onClose: () => void }) {
  const [pair, setPair] = useState<PairStart | null>(null);
  const start = useMutation({
    mutationFn: devicesApi.pair,
    onSuccess: setPair,
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't make a code.")),
  });
  const { mutate } = start;
  useEffect(() => mutate(), [mutate]);

  const { data: status } = useQuery({
    queryKey: ["device-pair", pair?.code],
    queryFn: () => devicesApi.status(pair!.code),
    enabled: !!pair,
    refetchInterval: (q) => (q.state.data && q.state.data.state !== "waiting" ? false : 2000),
  });
  const state = status?.state ?? "waiting";

  return (
    <Modal open onClose={onClose} title="Add a device" widthClass="max-w-md">
      {state === "paired" && status?.state === "paired" ? (
        <div className="py-4 text-center">
          <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-emerald-500" />
          <p className="text-sm font-medium text-[var(--text)]">“{status.device}” is linked</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Choose the folders to back up on the phone — syncing starts as soon as you do.
          </p>
          <Button className="mt-4" variant="primary" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-[var(--text)]">
            <li>Scan this code with your phone's camera and install PromptlySync.</li>
            <li>Open PromptlySync and scan the same code to link it to your account.</li>
            <li>Pick the folders to back up.</li>
          </ol>
          <div className="flex justify-center">
            {pair && state === "waiting" ? (
              <img
                src={pair.qr}
                alt="Pairing QR code"
                className="h-56 w-56 rounded-md border border-[var(--border)] bg-white p-2"
              />
            ) : (
              <div className="flex h-56 w-56 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-[var(--border)] text-center text-xs text-[var(--text-muted)]">
                {state === "expired" ? (
                  <>
                    This code has expired.
                    <Button
                      variant="secondary"
                      size="sm"
                      leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                      loading={start.isPending}
                      onClick={() => {
                        setPair(null);
                        start.mutate();
                      }}
                    >
                      New code
                    </Button>
                  </>
                ) : (
                  "Making a code…"
                )}
              </div>
            )}
          </div>
          {pair && state === "waiting" && (
            <p className="text-center text-xs text-[var(--text-muted)]">
              Waiting for the phone… The code works once, for 10 minutes.
              <br />
              No camera?{" "}
              <a href={pair.url} className="text-[var(--accent-text)] hover:underline" target="_blank" rel="noreferrer">
                Open the download page
              </a>
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
