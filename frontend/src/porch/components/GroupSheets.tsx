import { TilesSkeleton } from "./ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, ImagePlus, Lock, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { porchApi, type PorchGroup, type PorchUser, type Suggested, type Visibility } from "@/api/porch";
import { photosApi } from "@/api/photos";
import { EmojiGrid } from "@/rooms/components/ui";
import { Field, ItemButton, Sheet, TextArea, TextInput, Toggle } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { useGroupActions } from "../actions";
import { groupKey, groupsChanged } from "../cache";
import { PeoplePicker } from "./PeoplePicker";
import { GroupTile } from "./ui";

const GROUP_EMOJI = ["👨‍👩‍👧", "🏠", "🍻", "🎣", "⚽", "📚", "🎮", "🍕", "✈️", "🐶", "🌱", "🎉", "❤️", "🌏"];

function GroupLook({
  name,
  emoji,
  setName,
  setEmoji,
  autoFocus,
  coverUrl,
}: {
  name: string;
  emoji: string;
  setName: (v: string) => void;
  setEmoji: (v: string) => void;
  autoFocus?: boolean;
  coverUrl?: string | null;
}) {
  const [more, setMore] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-3">
        <GroupTile group={{ name: name || "?", emoji, cover_url: coverUrl }} size={56} />
        <Field label="Name" className="flex-1">
          <TextInput
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="Family, The Lads, Fishing…"
            data-autofocus={autoFocus ? "" : undefined}
          />
        </Field>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--text-muted)]" id="porch-emoji-label">
          Emoji
        </span>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby="porch-emoji-label">
          {[...(GROUP_EMOJI.includes(emoji) || !emoji ? [] : [emoji]), ...GROUP_EMOJI].map((e) => (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={emoji === e}
              aria-label={e}
              onClick={() => setEmoji(emoji === e ? "" : e)}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-xl border text-lg",
                emoji === e ? "border-[var(--item-accent)] bg-[var(--hover)]" : "border-[var(--border)] hover:bg-[var(--hover)]",
              )}
            >
              {e}
            </button>
          ))}
          <button
            type="button"
            aria-expanded={more}
            onClick={() => setMore((v) => !v)}
            className="flex h-10 items-center justify-center rounded-xl border border-[var(--border)] px-3 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover)]"
          >
            {more ? "Fewer" : "More…"}
          </button>
        </div>
        {more && (
          <EmojiGrid
            className="rounded-xl border border-[var(--border)]"
            onPick={(e) => {
              setEmoji(e);
              setMore(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function VisibilityChoice({ value, onChange, name }: { value: Visibility; onChange: (v: Visibility) => void; name?: string }) {
  const card = (v: Visibility, Icon: typeof Lock, title: string, text: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === v}
      onClick={() => onChange(v)}
      className={cn(
        "flex flex-1 flex-col gap-1 rounded-2xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
        value === v ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_8%,var(--surface))]" : "border-[var(--border)] hover:bg-[var(--hover)]",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
        <Icon className="h-4 w-4" aria-hidden /> {title}
      </span>
      <span className="text-xs text-[var(--text-muted)]">{text}</span>
    </button>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[var(--text-muted)]" id="porch-vis-label">
        Who can find it
      </span>
      <div className="flex flex-col gap-2 sm:flex-row" role="radiogroup" aria-labelledby="porch-vis-label">
        {card("private", Lock, "Private", `Only people you invite can see ${name || "it"} or know it exists. Good for family.`)}
        {card("public", Globe2, "Public", `Anyone on this Promptly can find ${name || "it"} and join.`)}
      </div>
    </div>
  );
}

/** New group: name, emoji, private (the default) or public, and who to invite. */
export function NewGroupSheet({
  open,
  onClose,
  preset,
}: {
  open: boolean;
  onClose: () => void;
  preset?: { name?: string; emoji?: string; invite?: PorchUser[] };
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [invite, setInvite] = useState<PorchUser[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(preset?.name ?? "");
    setEmoji(preset?.emoji ?? "");
    setVisibility("private");
    setInvite(preset?.invite ?? []);
  }, [open, preset]);
  const suggested = useQuery({ queryKey: ["porch", "suggested"], queryFn: porchApi.suggested, enabled: open, staleTime: 5 * 60_000 });

  const make = async () => {
    setBusy(true);
    try {
      const g = await porchApi.createGroup({ name: name.trim(), emoji, visibility, invite: invite.map((u) => u.id) });
      groupsChanged(qc, g.id);
      const n = g.invited.length;
      toast.success(n ? `${g.name} is ready. ${n === 1 ? "1 person" : `${n} people`} invited.` : `${g.name} is ready.`);
      onClose();
      navigate(`/porch/g/${g.id}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't make the group. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New group"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <ItemButton variant="ghost" onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton variant="primary" onClick={() => void make()} disabled={busy || !name.trim()}>
            Make group
          </ItemButton>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <GroupLook name={name} emoji={emoji} setName={setName} setEmoji={setEmoji} autoFocus />
        <VisibilityChoice value={visibility} onChange={setVisibility} name={name.trim()} />
        <PeoplePicker value={invite} onChange={setInvite} suggested={suggested.data ?? []} />
        <p className="text-xs text-[var(--text-muted)]">Everyone you invite gets asked first. Nobody is added to a group they didn't want. A cover and an "about" can be added later.</p>
      </div>
    </Sheet>
  );
}

/** Invite more people (admins, or everyone when "Members can invite" is on). */
export function InviteSheet({ group, open, onClose, exclude }: { group: PorchGroup; open: boolean; onClose: () => void; exclude: string[] }) {
  const qc = useQueryClient();
  const [invite, setInvite] = useState<PorchUser[]>([]);
  const [busy, setBusy] = useState(false);
  const suggested = useQuery({ queryKey: ["porch", "suggested"], queryFn: porchApi.suggested, enabled: open, staleTime: 5 * 60_000 });
  useEffect(() => {
    if (open) setInvite([]);
  }, [open]);
  const send = async () => {
    setBusy(true);
    try {
      const done = await porchApi.invite(group.id, invite.map((u) => u.id));
      groupsChanged(qc, group.id);
      toast.success(done.length ? `Invited ${done.length === 1 ? "1 person" : `${done.length} people`}. They'll be asked to join.` : "They're already in the group or invited.");
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't send the invites. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Invite to ${group.name}`}
      footer={
        <div className="flex justify-end gap-2">
          <ItemButton variant="ghost" onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton variant="primary" onClick={() => void send()} disabled={busy || invite.length === 0}>
            {invite.length > 1 ? `Invite ${invite.length} people` : "Invite"}
          </ItemButton>
        </div>
      }
    >
      <PeoplePicker value={invite} onChange={setInvite} suggested={suggested.data ?? []} exclude={exclude} label="Who to invite" />
      <p className="mt-3 text-xs text-[var(--text-muted)]">They get an invite to accept or decline.</p>
    </Sheet>
  );
}

/** Edit group (admins): name, emoji, cover, about, public or private, who can
 *  invite; delete (the owner). Everyone: its name and emoji only. */
export function EditGroupSheet({ group, open, onClose }: { group: PorchGroup; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { remove } = useGroupActions();
  const everyone = group.kind === "everyone";
  const [name, setName] = useState(group.name);
  const [emoji, setEmoji] = useState(group.emoji);
  const [about, setAbout] = useState(group.about);
  const [visibility, setVisibility] = useState<Visibility>(group.visibility);
  const [canInvite, setCanInvite] = useState(group.members_can_invite);
  const [cover, setCover] = useState<{ id: string | null; url: string | null } | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(group.name);
    setEmoji(group.emoji);
    setAbout(group.about);
    setVisibility(group.visibility);
    setCanInvite(group.members_can_invite);
    setCover(undefined);
  }, [open, group]);

  const save = async () => {
    setBusy(true);
    try {
      const patch: Parameters<typeof porchApi.updateGroup>[1] = { name: name.trim(), emoji, about };
      if (!everyone) {
        patch.visibility = visibility;
        patch.members_can_invite = canInvite;
      }
      if (cover !== undefined) patch.cover_file_id = cover.id;
      const g = await porchApi.updateGroup(group.id, patch);
      qc.setQueryData(groupKey(g.id), g);
      groupsChanged(qc, g.id);
      toast.success("Group saved.");
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't save the group. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const shownCover = cover !== undefined ? cover.url : group.cover_url;
  return (
    <>
      <Sheet
        open={open && !picking}
        onClose={onClose}
        title={`Edit ${group.name}`}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <ItemButton variant="ghost" onClick={onClose}>
              Cancel
            </ItemButton>
            <ItemButton variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
              Save
            </ItemButton>
          </div>
        }
      >
        <div className="flex flex-col gap-5">
          <GroupLook name={name} emoji={emoji} setName={setName} setEmoji={setEmoji} coverUrl={shownCover} />
          {!everyone && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-muted)]">Cover</span>
              <div className="flex flex-wrap gap-2">
                <ItemButton size="sm" variant="secondary" icon={<ImagePlus className="h-4 w-4" />} onClick={() => setPicking(true)}>
                  {shownCover ? "Change cover" : "Choose from your Photos"}
                </ItemButton>
                {shownCover && (
                  <ItemButton size="sm" variant="ghost" onClick={() => setCover({ id: null, url: null })}>
                    Remove cover
                  </ItemButton>
                )}
              </div>
            </div>
          )}
          <Field label="About">
            <TextArea value={about} maxLength={500} onChange={(e) => setAbout(e.target.value)} placeholder="What it's for, in a line or two" rows={3} />
          </Field>
          {!everyone && (
            <>
              <VisibilityChoice value={visibility} onChange={setVisibility} name={name.trim()} />
              {visibility !== group.visibility && (
                <p className="rounded-xl bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text)]">
                  {visibility === "private"
                    ? `Going private hides ${name.trim() || group.name} from everyone who isn't in it.`
                    : `Going public lists ${name.trim() || group.name} under Find groups, where anyone here can join it.`}
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[var(--text)]">Members can invite</p>
                  <p className="text-xs text-[var(--text-muted)]">Off: only admins invite people.</p>
                </div>
                <Toggle checked={canInvite} onChange={setCanInvite} label="Members can invite" />
              </div>
            </>
          )}
          {group.is_owner && (
            <div className="border-t border-[var(--border)] pt-4">
              <ItemButton variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => void remove(group).then((ok) => ok && onClose())}>
                Delete group
              </ItemButton>
            </div>
          )}
        </div>
      </Sheet>
      <CoverPicker
        open={open && picking}
        onClose={() => setPicking(false)}
        onPick={(id, url) => {
          setCover({ id, url });
          setPicking(false);
        }}
      />
    </>
  );
}

/** A photo from your own Photos library, for a group's cover. */
function CoverPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string, url: string | null) => void }) {
  const q = useQuery({
    queryKey: ["porch", "cover-photos"],
    queryFn: () => photosApi.timeline({ view: "all", limit: 60 }),
    enabled: open,
    staleTime: 60_000,
  });
  const items = (q.data?.items ?? []).filter((p) => p.kind === "image" && p.mine !== false && p.thumb);
  return (
    <Sheet open={open} onClose={onClose} title="Choose a cover" size="lg">
      {q.isPending ? (
        <TilesSkeleton tiles={9} />
      ) : q.isError ? (
        <p className="py-8 text-center text-sm text-[var(--danger)]">Couldn't load your photos.</p>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-muted)]">No photos in your library yet. Add some in Photos, then come back.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
          {items.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p.id, p.thumb)}
                aria-label={`Use ${p.filename}`}
                className="block aspect-square w-full overflow-hidden rounded-lg bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
              >
                <img src={p.thumb ?? undefined} alt="" loading="lazy" className="h-full w-full object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

export type { Suggested };
