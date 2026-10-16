import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Crown, LogOut, UserMinus } from "lucide-react";

import { familyApi, type Family, type FamilyShareMode } from "@/api/family";
import { peopleApi } from "@/api/people";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Modal } from "@/components/shared/Modal";
import { UserPicker, type UserPickerValue } from "@/components/shared/UserPicker";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/** The family library (PH-5): start one, add people, and choose what of
 *  yours goes in — nothing, all of it, from a date, or photos with certain
 *  people. Everyone in the family sees what the others share. */
export function FamilyDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: family, isLoading } = useQuery({ queryKey: ["photo-family"], queryFn: familyApi.get });
  const set = (f: Family | null) => {
    qc.setQueryData(["photo-family"], f);
    void qc.invalidateQueries({ queryKey: ["photos"] });
  };
  const run = async (what: () => Promise<Family | null>, done?: string) => {
    try {
      set(await what());
      if (done) toast.success(done);
    } catch (e) {
      toast.error(apiErrorMessage(e, "That didn't work."));
    }
  };

  return (
    <Modal open onClose={onClose} title={family ? family.name : "Family library"} widthClass="max-w-lg">
      {isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading…</p>
      ) : !family ? (
        <Start onStart={(name) => void run(() => familyApi.create(name), "Family library started.")} />
      ) : (
        <div className="space-y-5 text-sm">
          <Members family={family} run={run} />
          <Share family={family} run={run} />
        </div>
      )}
    </Modal>
  );
}

function Start({ onStart }: { onStart: (name: string) => void }) {
  const [name, setName] = useState("Family");
  return (
    <div className="space-y-3 text-sm">
      <p className="text-[var(--text-muted)]">
        A family library pools photos with people on this server. Each person chooses what of theirs goes in — all of it, from a
        date, or photos with certain people — and everyone sees what the others share. Nobody's photos are shared until they say so.
      </p>
      <label className="block">
        <span className="text-xs font-medium text-[var(--text-muted)]">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Family name"
          className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1" />
      </label>
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={() => onStart(name)}>Start a family library</Button>
      </div>
    </div>
  );
}

function Members({ family, run }: { family: Family; run: (what: () => Promise<Family | null>, done?: string) => Promise<void> }) {
  const [who, setWho] = useState<UserPickerValue>(null);
  const shares: Record<FamilyShareMode, string> = { none: "not sharing yet", all: "sharing everything", since: "sharing from a date", people: "sharing photos of some people" };
  return (
    <section aria-label="People in the family">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">People</h3>
      <ul className="space-y-1">
        {family.members.map((m) => (
          <li key={m.user_id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--hover)]">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{m.username}</span>
              {m.you && <span className="text-[var(--text-muted)]"> (you)</span>}
              {m.owner && <Crown className="ml-1 inline h-3 w-3 text-amber-500" aria-label="Owner" />}
              <span className="block text-xs text-[var(--text-muted)]">
                {shares[m.sharing]}{m.photos ? ` · ${m.photos.toLocaleString()} ${m.photos === 1 ? "photo" : "photos"}` : ""}
              </span>
            </span>
            {family.owner && !m.you && (
              <button type="button" aria-label={`Remove ${m.username}`} title="Remove — their photos leave the family"
                onClick={async () => {
                  if (await confirm({ title: `Remove ${m.username}?`, message: "Their photos leave the family library; they keep them.", confirmLabel: "Remove", danger: true })) {
                    void run(() => familyApi.removeMember(m.user_id));
                  }
                }}
                className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]">
                <UserMinus className="h-4 w-4" />
              </button>
            )}
            {m.you && (
              <button type="button" aria-label={family.owner ? "End the family library" : "Leave the family"}
                title={family.owner ? "End the family library for everyone" : "Leave — your photos leave with you"}
                onClick={async () => {
                  const ok = await confirm(family.owner
                    ? { title: "End the family library?", message: "Everyone's shared photos leave it; nobody loses a photo.", confirmLabel: "End it", danger: true }
                    : { title: "Leave the family?", message: "Your photos leave the family library, and you stop seeing theirs.", confirmLabel: "Leave", danger: true });
                  if (ok) void run(() => familyApi.removeMember(m.user_id));
                }}
                className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]">
                <LogOut className="h-4 w-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {family.owner && (
        <div className="mt-2">
          <UserPicker value={who} onChange={setWho} excludeUserIds={family.members.map((m) => m.user_id)} placeholder="Add someone by name or email"
            onSubmit={() => who?.kind === "user" && void run(() => familyApi.addMember(who.user.user_id), "Added — they choose what of theirs to share.").then(() => setWho(null))} />
          <div className="mt-1.5 flex justify-end">
            <Button size="sm" variant="secondary" disabled={who?.kind !== "user"}
              onClick={() => who?.kind === "user" && void run(() => familyApi.addMember(who.user.user_id), "Added — they choose what of theirs to share.").then(() => setWho(null))}>
              Add to family
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function Share({ family, run }: { family: Family; run: (what: () => Promise<Family | null>, done?: string) => Promise<void> }) {
  const [mode, setMode] = useState<FamilyShareMode>(family.share.mode);
  const [since, setSince] = useState(family.share.since ?? "");
  const [people, setPeople] = useState<string[]>(family.share.people.map((p) => p.id));
  useEffect(() => {
    setMode(family.share.mode);
    setSince(family.share.since ?? "");
    setPeople(family.share.people.map((p) => p.id));
  }, [family.share]);
  const { data: mine } = useQuery({ queryKey: ["people", "person", false], queryFn: () => peopleApi.list("person"), enabled: mode === "people" });
  const options: { id: FamilyShareMode; label: string }[] = [
    { id: "none", label: "Nothing" },
    { id: "all", label: "All my photos" },
    { id: "since", label: "Photos from a date" },
    { id: "people", label: "Photos with certain people" },
  ];
  const changed = mode !== family.share.mode || (mode === "since" && since !== (family.share.since ?? ""))
    || (mode === "people" && people.join() !== family.share.people.map((p) => p.id).join());
  return (
    <section aria-label="What you share">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">What you share</h3>
      <div role="radiogroup" aria-label="What you share" className="space-y-1">
        {options.map((o) => (
          <label key={o.id} className="flex items-center gap-2">
            <input type="radio" name="family-share" checked={mode === o.id} onChange={() => setMode(o.id)} /> {o.label}
          </label>
        ))}
      </div>
      {mode === "since" && (
        <input type="date" value={since} onChange={(e) => setSince(e.target.value)} aria-label="Shared from"
          className="mt-2 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1" />
      )}
      {mode === "people" && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(mine ?? []).filter((p) => p.name).map((p) => (
            <button key={p.id} type="button" aria-pressed={people.includes(p.id!)}
              onClick={() => setPeople((cur) => (cur.includes(p.id!) ? cur.filter((x) => x !== p.id) : [...cur, p.id!]))}
              className={cn("rounded-full border px-2.5 py-0.5 text-xs",
                people.includes(p.id!) ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-text)]" : "border-[var(--border)] hover:bg-[var(--hover)]")}>
              {p.name}
            </button>
          ))}
          {mine && !mine.some((p) => p.name) && <p className="text-xs text-[var(--text-muted)]">Name people in Photos → People first.</p>}
        </div>
      )}
      <p className="mt-2 text-xs text-[var(--text-muted)]">Archived photos are never shared. New photos that fit join by themselves.</p>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="primary" disabled={!changed || (mode === "since" && !since) || (mode === "people" && !people.length)}
          onClick={() => void run(() => familyApi.share(mode, mode === "since" ? since : null, mode === "people" ? people : []), "Saved.")}>
          Save
        </Button>
      </div>
    </section>
  );
}
