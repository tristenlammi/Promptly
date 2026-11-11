import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Loader2, Smartphone } from "lucide-react";
import { Link } from "react-router-dom";

import { devicesApi } from "@/api/devices";
import { photosApi } from "@/api/photos";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Modal } from "@/components/shared/Modal";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** Photos settings (PH-2): face recognition is off until you turn it on,
 *  and turning it off deletes every face found at once. */
export function PhotoSettingsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["photos", "settings"], queryFn: photosApi.settings });
  // What the box shows while a change is on its way.
  const [pending, setPending] = useState<boolean | null>(null);
  const save = useMutation({
    mutationFn: (faces: boolean) => photosApi.saveSettings({ faces }),
    onSuccess: (s) => {
      qc.setQueryData(["photos", "settings"], s);
      void qc.invalidateQueries({ queryKey: ["photos", "understanding"] });
      toast.success(s.faces ? "Faces will be found in the background." : "Face recognition is off, and every face found is deleted.");
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't save that.")),
    onSettled: () => setPending(null),
  });

  const toggle = async (on: boolean) => {
    setPending(on);
    if (!on && (data?.face_count ?? 0) > 0) {
      const ok = await confirm({
        title: "Turn off face recognition?",
        message: `The ${data!.face_count.toLocaleString()} faces found in your photos are deleted. Your photos aren't touched.`,
        confirmLabel: "Turn off and delete",
        danger: true,
      });
      if (!ok) {
        setPending(null);
        return;
      }
    }
    save.mutate(on);
  };

  return (
    <Modal open onClose={onClose} title="Photos settings" widthClass="max-w-md">
      <PhoneBackup />
      <PhotosFolder />
      <label className="mt-4 flex items-start gap-3 border-t border-[var(--border)] pt-4">
        <input
          type="checkbox"
          className="mt-1"
          checked={pending ?? !!data?.faces}
          disabled={!data || save.isPending}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>
          <span className="block text-sm font-medium text-[var(--text)]">Recognise faces</span>
          <span className="mt-1 block text-xs text-[var(--text-muted)]">
            Finds the faces in your photos so you can name the people in them and ask for “photos of Mum”. It all happens on
            this server — no face leaves it — and only in your own photos. Turning it off deletes every face found, at once.
          </span>
          {data?.faces && (
            <span className="mt-1 block text-xs text-[var(--text-muted)]">{data.face_count.toLocaleString()} faces found so far.</span>
          )}
        </span>
      </label>
      <Captions />
    </Modal>
  );
}

/** Back up a phone's camera roll into Photos — the Promptly Android app's
 *  photo backup. On the phone: link it in one tap (a pairing code handed
 *  straight to the app), or open its backup settings. Elsewhere: Files →
 *  Devices, which shows the QR code to scan. */
function PhoneBackup() {
  const [busy, setBusy] = useState(false);
  const android = /android/i.test(navigator.userAgent);
  const link = async () => {
    setBusy(true);
    try {
      const { code } = await devicesApi.pair();
      location.href = `promptlysync://pair?server=${encodeURIComponent(location.origin)}&code=${encodeURIComponent(code)}`;
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't start linking this phone."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-4 border-b border-[var(--border)] pb-4">
      <h3 className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
        <Smartphone className="h-4 w-4 text-[var(--text-muted)]" /> Phone backup
      </h3>
      {android ? (
        <>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Backs up this phone's photos and videos to Photos in the background, with the Promptly app.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void link()}
              disabled={busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--accent-strong)] px-3 text-xs font-semibold text-white disabled:opacity-60"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Set up backup on this phone
            </button>
            <a
              href="promptlysync://pair"
              className="inline-flex h-8 items-center rounded-lg border border-[var(--border)] px-3 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)]"
            >
              Open backup settings
            </a>
          </div>
          <p className="mt-2 text-[11px] text-[var(--text-muted)]">
            Needs the Promptly app — <Link to="/apps/install" className="text-[var(--accent-text)] hover:underline">get it from Install apps</Link>.
          </p>
        </>
      ) : (
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Back up a phone's photos and videos here automatically:{" "}
          <Link to="/files/devices" className="text-[var(--accent-text)] hover:underline">
            Files → Devices → Add device
          </Link>
          .
        </p>
      )}
    </section>
  );
}

/** Photos is one folder (like Google Photos): what's in it, and the
 *  folders inside it, is your library — nothing elsewhere in My files. */
function PhotosFolder() {
  const { data } = useQuery({ queryKey: ["photos", "settings"], queryFn: photosApi.settings });
  if (!data) return null;
  return (
    <div>
      <p className="text-sm font-medium text-[var(--text)]">Your Photos folder</p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Photos shows what's in the <b>{data.folder.name}</b> folder in My files, and the folders inside it. Uploads here,
        phone backups and imports go into it by the month they were taken. Pictures elsewhere in My files aren't in
        Photos — use “Move to Photos” on one to add it.
      </p>
      <Link
        to={`/files/folder/${data.folder.id}`}
        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-text)] hover:underline"
      >
        <FolderOpen className="h-3.5 w-3.5" /> Open it in My files
      </Link>
    </div>
  );
}

/** Describing photos (PH-2): one sentence and some tags for each, from the
 *  model an admin chose — named here, and whether it's on this server. */
function Captions() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["photos", "settings"], queryFn: photosApi.settings });
  const [pending, setPending] = useState<boolean | null>(null);
  const save = useMutation({
    mutationFn: (captions: boolean) => photosApi.saveSettings({ captions }),
    onSuccess: (s) => {
      qc.setQueryData(["photos", "settings"], s);
      void qc.invalidateQueries({ queryKey: ["photos", "understanding"] });
      toast.success(s.captions ? "Your photos will be described in the background." : "Describing photos is off, and the descriptions are deleted.");
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't save that.")),
    onSettled: () => setPending(null),
  });
  const model = data?.captions_model;
  return (
    <label className="mt-4 flex items-start gap-3 border-t border-[var(--border)] pt-4">
      <input
        type="checkbox"
        className="mt-1"
        checked={pending ?? !!data?.captions}
        disabled={!data || !model || save.isPending}
        onChange={(e) => {
          setPending(e.target.checked);
          save.mutate(e.target.checked);
        }}
      />
      <span>
        <span className="block text-sm font-medium text-[var(--text)]">Describe my photos</span>
        <span className="mt-1 block text-xs text-[var(--text-muted)]">
          {model ? (
            model.local ? (
              <>A sentence and a few tags for each photo, written by {model.label}, so you can search for “birthday party” or “sunset on the water”.</>
            ) : (
              <>
                A sentence and a few tags for each photo, written by {model.label} — a service outside this server: each
                photo is sent to it, at most 1024 pixels and without its location. Turning it off deletes the descriptions.
              </>
            )
          ) : data ? (
            <>Not available yet: an admin chooses the model that describes photos (Admin → Models → Defaults → Photos vision).</>
          ) : (
            "…"
          )}
        </span>
      </span>
    </label>
  );
}
