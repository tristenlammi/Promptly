import { useQueryClient } from "@tanstack/react-query";
import { Crown, LogOut, Shield, Trash2, UserMinus, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { roomsApi, type Bootstrap, type RoomUser, type Space, type SpaceRole } from "@/api/rooms";
import { Field, ItemButton, Segmented, Select, Sheet, TextInput } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { BOOTSTRAP_KEY, updateBootstrap } from "../cache";
import { SPACE_COLORS } from "../format";
import { askInSheet } from "./ConfirmSheet";
import { PeoplePicker } from "./PeoplePicker";
import { NotifyControl, SpaceIcon, UserAvatar } from "./ui";

const SPACE_EMOJI = ["", "🏠", "👨‍👩‍👧", "🍻", "🎮", "⚽", "🎵", "📚", "💼", "✈️", "🍕", "🐶", "🌱", "🎉", "❤️", "⭐"];

function SpaceLook({
  name,
  emoji,
  color,
  setName,
  setEmoji,
  setColor,
  autoFocus,
  onEnter,
}: {
  name: string;
  emoji: string;
  color: string;
  setName: (v: string) => void;
  setEmoji: (v: string) => void;
  setColor: (v: string) => void;
  autoFocus?: boolean;
  /** Enter in the name box does the sheet's main thing. */
  onEnter?: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <SpaceIcon space={{ name: name || "?", emoji, color }} size={56} />
        <Field label="Name" className="flex-1">
          <TextInput
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && onEnter) {
                e.preventDefault();
                onEnter();
              }
            }}
            placeholder="Family, The Lads, Book club…"
            data-autofocus={autoFocus ? "" : undefined}
          />
        </Field>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--text-muted)]">Icon</span>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Icon">
          {SPACE_EMOJI.map((e) => (
            <button
              key={e || "initials"}
              type="button"
              role="radio"
              aria-checked={emoji === e}
              aria-label={e || "Initials"}
              onClick={() => setEmoji(e)}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-xl border text-lg",
                emoji === e ? "border-[var(--accent)] bg-[var(--hover)]" : "border-[var(--border)] hover:bg-[var(--hover)]",
              )}
            >
              {e || <span className="text-xs font-semibold text-[var(--text-muted)]">Aa</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--text-muted)]">Colour</span>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
          {SPACE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              onClick={() => setColor(c)}
              className={cn("h-9 w-9 rounded-full ring-offset-2 ring-offset-[var(--bg)]", color === c && "ring-2 ring-[var(--text)]")}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function CreateSpaceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🏠");
  const [color, setColor] = useState(SPACE_COLORS[0]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName("");
      setEmoji("🏠");
      setColor(SPACE_COLORS[Math.floor(Math.random() * SPACE_COLORS.length)]);
    }
  }, [open]);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const space = await roomsApi.createSpace({ name: name.trim(), emoji: emoji || null, color });
      await qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      onClose();
      const b = qc.getQueryData<Bootstrap>(BOOTSTRAP_KEY);
      const first = space.rooms?.[0] ?? b?.spaces.find((s) => s.id === space.id)?.rooms[0];
      if (first) navigate(`/rooms/r/${first.id}`);
      toast.success(`${space.name} is ready. Add people from its settings.`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't create the space."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Create a space"
      footer={
        <ItemButton variant="primary" block disabled={!name.trim() || busy} onClick={() => void create()}>
          Create space
        </ItemButton>
      }
    >
      <p className="mb-4 text-sm text-[var(--text-muted)]">
        A space is a home for a group — family, friends, a club — with its own rooms. It starts with <b>#general</b>.
      </p>
      <SpaceLook name={name} emoji={emoji} color={color} setName={setName} setEmoji={setEmoji} setColor={setColor} autoFocus onEnter={() => !busy && void create()} />
    </Sheet>
  );
}

export function SpaceSettingsSheet({
  open,
  onClose,
  space,
  b,
}: {
  open: boolean;
  onClose: () => void;
  space: Space;
  b: Bootstrap;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = space.role === "owner" || space.role === "admin";
  const [tab, setTab] = useState<"general" | "members">("general");
  const [name, setName] = useState(space.name);
  const [emoji, setEmoji] = useState(space.emoji ?? "");
  const [color, setColor] = useState(space.color ?? SPACE_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<RoomUser[]>([]);

  useEffect(() => {
    if (open) {
      setName(space.name);
      setEmoji(space.emoji ?? "");
      setColor(space.color ?? SPACE_COLORS[0]);
      setAdding(false);
      setPicked([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, space.id]);

  const refresh = () => qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
  const run = async (fn: () => Promise<unknown>, fail: string, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (ok) toast.success(ok);
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, fail));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const dirty = name.trim() !== space.name || (emoji || null) !== (space.emoji || null) || color !== (space.color ?? SPACE_COLORS[0]);

  const saveLook = () => {
    if (!dirty || !name.trim() || busy) return;
    void run(() => roomsApi.updateSpace(space.id, { name: name.trim(), emoji: emoji || null, color }), "Couldn't save.", "Saved");
  };

  const leave = async () => {
    if (
      !(await askInSheet({
        title: `Leave ${space.name}?`,
        message: "You'll need someone to add you back.",
        confirmLabel: "Leave space",
        danger: true,
      }))
    )
      return;
    if (await run(() => roomsApi.removeSpaceMember(space.id, b.me.id), "Couldn't leave the space.", `You left ${space.name}.`)) {
      onClose();
      navigate("/rooms/");
    }
  };
  const del = async () => {
    const ok = await askInSheet({
      title: `Delete ${space.name}?`,
      message: "All its rooms and messages are deleted for everyone. This can't be undone.",
      confirmLabel: "Delete space",
      danger: true,
      typeToConfirm: space.name,
    });
    if (!ok) return;
    if (await run(() => roomsApi.deleteSpace(space.id), "Couldn't delete the space.", `${space.name} was deleted.`)) {
      updateBootstrap(qc, (cur) => ({ ...cur, spaces: cur.spaces.filter((s) => s.id !== space.id) }));
      onClose();
      navigate("/rooms/");
    }
  };

  const roleOf = (id: string): SpaceRole | undefined => space.member_roles?.[id] ?? (id === b.me.id ? space.role : undefined);
  const members = [...space.member_ids].sort((x, y) => (b.users[x]?.username ?? "").localeCompare(b.users[y]?.username ?? ""));

  return (
    <Sheet open={open} onClose={onClose} title={`${space.name} settings`} size="md">
      <div className="flex flex-col gap-5">
        <Segmented
          className="w-full"
          value={tab}
          onChange={setTab}
          options={[
            { value: "general", label: "General" },
            { value: "members", label: `Members (${space.member_ids.length})` },
          ]}
        />
        {tab === "general" ? (
          <>
            {isAdmin ? (
              <>
                <SpaceLook name={name} emoji={emoji} color={color} setName={setName} setEmoji={setEmoji} setColor={setColor} onEnter={saveLook} />
                <ItemButton variant="primary" disabled={!dirty || !name.trim() || busy} onClick={saveLook}>
                  Save changes
                </ItemButton>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <SpaceIcon space={space} size={48} />
                <div>
                  <p className="font-semibold text-[var(--text)]">{space.name}</p>
                  <p className="text-xs text-[var(--text-muted)]">You're a member. Admins can change the name and rooms.</p>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-muted)]">Notifications for this space</span>
              <NotifyControl
                value={space.notify}
                onChange={(v) => {
                  const notify = v ?? "all";
                  updateBootstrap(qc, (cur) => ({ ...cur, spaces: cur.spaces.map((s) => (s.id === space.id ? { ...s, notify } : s)) }));
                  void roomsApi.setSpaceNotify(space.id, notify).catch((err) => {
                    toast.error(apiErrorMessage(err, "Couldn't change notifications."));
                    void refresh();
                  });
                }}
              />
              <span className="text-xs text-[var(--text-muted)]">
                Mentions = only when someone @mentions you, @everyone, or replies to you. Each room can override this.
              </span>
            </div>
            <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-4">
              {space.role !== "owner" && (
                <ItemButton variant="secondary" icon={<LogOut className="h-4 w-4" />} disabled={busy} onClick={() => void leave()}>
                  Leave space
                </ItemButton>
              )}
              {space.role === "owner" && (
                <ItemButton variant="danger" icon={<Trash2 className="h-4 w-4" />} disabled={busy} onClick={() => void del()}>
                  Delete space
                </ItemButton>
              )}
            </div>
          </>
        ) : adding ? (
          <div className="flex flex-col gap-3">
            <PeoplePicker selected={picked} onChange={setPicked} exclude={space.member_ids} />
            <div className="flex gap-2">
              <ItemButton variant="ghost" onClick={() => setAdding(false)}>
                Back
              </ItemButton>
              <ItemButton
                variant="primary"
                className="flex-1"
                disabled={!picked.length || busy}
                onClick={async () => {
                  const ok = await run(
                    () => roomsApi.addSpaceMembers(space.id, picked.map((u) => u.id)),
                    "Couldn't add them.",
                    `Added ${picked.length} ${picked.length === 1 ? "person" : "people"}.`,
                  );
                  if (ok) {
                    setPicked([]);
                    setAdding(false);
                  }
                }}
              >
                Add {picked.length || ""} to {space.name}
              </ItemButton>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {isAdmin && (
              <ItemButton variant="secondary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                Add people
              </ItemButton>
            )}
            <ul className="flex flex-col divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              {members.map((id) => {
                const u = b.users[id];
                const role = roleOf(id);
                const me = id === b.me.id;
                const canEdit = isAdmin && !me && role !== "owner" && !(space.role === "admin" && role === "admin");
                return (
                  <li key={id} className="flex min-h-[52px] items-center gap-2.5 px-3 py-1.5">
                    <UserAvatar user={u} size={32} />
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
                      {u?.username ?? "Someone"}
                      {me && <span className="text-[var(--text-muted)]"> (you)</span>}
                    </span>
                    {canEdit && role ? (
                      <Select
                        aria-label={`Role for ${u?.username ?? "member"}`}
                        className="!h-9 !w-auto !text-sm"
                        value={role}
                        disabled={busy}
                        onChange={(e) =>
                          void run(
                            () => roomsApi.setSpaceMemberRole(space.id, id, e.target.value as SpaceRole),
                            "Couldn't change their role.",
                          )
                        }
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </Select>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
                        {role === "owner" && <Crown className="h-3.5 w-3.5 text-[var(--warning)]" />}
                        {role === "admin" && <Shield className="h-3.5 w-3.5 text-[var(--accent-text)]" />}
                        {role ? role[0].toUpperCase() + role.slice(1) : ""}
                      </span>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        aria-label={`Remove ${u?.username ?? "member"} from ${space.name}`}
                        disabled={busy}
                        onClick={async () => {
                          const ok = await askInSheet({
                            title: `Remove ${u?.username ?? "them"} from ${space.name}?`,
                            message: "They lose access to its rooms. You can add them back later.",
                            confirmLabel: "Remove",
                            danger: true,
                          });
                          if (ok) void run(() => roomsApi.removeSpaceMember(space.id, id), "Couldn't remove them.");
                        }}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]"
                      >
                        <UserMinus className="h-4 w-4" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Sheet>
  );
}
