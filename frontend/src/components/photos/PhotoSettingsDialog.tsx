import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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
      <label className="flex items-start gap-3">
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
