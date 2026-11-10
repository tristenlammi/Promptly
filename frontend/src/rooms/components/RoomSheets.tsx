import { useQueryClient } from "@tanstack/react-query";
import { EyeOff, Hash, Sparkles, Trash2, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { roomsApi, type Bootstrap, type NotifyLevel, type Room, type RoomUser, type Space } from "@/api/rooms";
import { Field, ItemButton, Sheet, TextArea, TextInput, Toggle } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { BOOTSTRAP_KEY, dmTitle, patchRoom, removeRoom, upsertRoom } from "../cache";
import { askInSheet } from "./ConfirmSheet";
import { PeoplePicker } from "./PeoplePicker";
import { ChannelVoiceSettings } from "@/rtc/ui/ChannelVoiceSettings";
import { cn } from "@/utils/cn";
import { NotifyControl, UserAvatar } from "./ui";

export const AI_CONTEXT_EXPLAINER =
  "Off: @promptly only sees the message that mentions it. On: it can read this room's recent messages to answer — everyone in the room sees that this is on.";

function slug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, 80);
}

/** Voice channels keep their spaces and capitals ("Movie night"). */
function voiceName(name: string) {
  return name.trim().replace(/\s+/g, " ").slice(0, 80);
}

export function CreateRoomSheet({
  open,
  onClose,
  space,
  kind: initialKind = "text",
  voiceAvailable = true,
}: {
  open: boolean;
  onClose: () => void;
  space: Space;
  kind?: "text" | "voice";
  /** Voice is on for you (else only text rooms are offered). */
  voiceAvailable?: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState<"text" | "voice">(initialKind);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName("");
      setTopic("");
      setKind(voiceAvailable ? initialKind : "text");
    }
  }, [open, initialKind, voiceAvailable]);
  const norm = kind === "voice" ? voiceName : slug;
  const create = async () => {
    const n = norm(name);
    if (!n) return;
    setBusy(true);
    try {
      const room = await roomsApi.createRoom(space.id, { name: n, topic: topic.trim(), kind });
      if (!upsertRoom(qc, room)) await qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      onClose();
      navigate(`/rooms/r/${room.id}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, kind === "voice" ? "Couldn't create the voice channel." : "Couldn't create the room."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={kind === "voice" ? `New voice channel in ${space.name}` : `New room in ${space.name}`}
      size="sm"
      footer={
        <ItemButton variant="primary" block disabled={!norm(name) || busy} onClick={() => void create()}>
          {kind === "voice" ? "Create voice channel" : "Create room"}
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3">
        {voiceAvailable && (
          <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Kind">
            {(
              [
                { value: "text", label: "Text room", text: "Messages, photos, files and @promptly", Icon: Hash },
                { value: "voice", label: "Voice channel", text: "Drop in to talk, share your screen, hang out", Icon: Volume2 },
              ] as const
            ).map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={kind === o.value}
                onClick={() => setKind(o.value)}
                className={cn(
                  "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                  kind === o.value ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]" : "border-[var(--border)] hover:bg-[var(--hover)]",
                )}
              >
                <o.Icon className="h-5 w-5 shrink-0 text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-[var(--text)]">{o.label}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{o.text}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <Field
          label="Name"
          hint={kind === "voice" ? "Like Lounge, Games or Movie night" : slug(name) ? `#${slug(name)}` : "Lower-case, no spaces — like #holidays"}
        >
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void create()}
            placeholder={kind === "voice" ? "Lounge" : "holidays"}
            maxLength={80}
            data-autofocus=""
          />
        </Field>
        <Field label="Topic (optional)">
          <TextInput
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void create()}
            placeholder="What's this room for?"
            maxLength={300}
          />
        </Field>
      </div>
    </Sheet>
  );
}

function NotifyRow({ room, space }: { room: Room; space: Space | null }) {
  const qc = useQueryClient();
  const change = (notify: NotifyLevel | null) => {
    const before = room.notify;
    patchRoom(qc, room.id, (r) => ({ ...r, notify }));
    roomsApi.updateMyRoom(room.id, { notify }).catch((err) => {
      patchRoom(qc, room.id, (r) => ({ ...r, notify: before }));
      toast.error(apiErrorMessage(err, "Couldn't change notifications."));
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[var(--text-muted)]">Notifications</span>
      <NotifyControl
        value={room.notify}
        onChange={change}
        allowInherit={!!space}
        inheritLabel={space ? `Space (${space.notify})` : undefined}
      />
    </div>
  );
}

export function RoomSettingsSheet({
  open,
  onClose,
  room,
  space,
}: {
  open: boolean;
  onClose: () => void;
  room: Room;
  space: Space;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const isAdmin = space.role === "owner" || space.role === "admin";
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(room.name);
      setTopic(room.topic ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, room.id]);

  const save = async (body: Parameters<typeof roomsApi.updateRoom>[1], ok?: string) => {
    setBusy(true);
    try {
      const r = await roomsApi.updateRoom(room.id, body);
      if (r) upsertRoom(qc, r);
      else patchRoom(qc, room.id, (cur) => ({ ...cur, ...body, topic: body.topic !== undefined ? body.topic ?? null : cur.topic }));
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't save."));
    } finally {
      setBusy(false);
    }
  };

  const isVoice = room.kind === "voice";
  const norm = isVoice ? voiceName : slug;
  const dirty = norm(name) !== room.name || topic.trim() !== (room.topic ?? "");

  return (
    <Sheet open={open} onClose={onClose} title={isVoice ? room.name : `#${room.name}`} size="md">
      <div className="flex flex-col gap-5">
        {isAdmin && (
          <div className="flex flex-col gap-3">
            <Field label="Name" hint={!isVoice && slug(name) && slug(name) !== name ? `#${slug(name)}` : undefined}>
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && dirty && norm(name) && !busy) void save({ name: norm(name), topic: topic.trim() || null }, "Saved");
                }}
                maxLength={80}
              />
            </Field>
            <Field label="Topic">
              <TextArea value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={300} placeholder="What's this room for?" className="!min-h-[64px]" />
            </Field>
            <ItemButton
              variant="primary"
              disabled={!dirty || !norm(name) || busy}
              onClick={() => void save({ name: norm(name), topic: topic.trim() || null }, "Saved")}
            >
              Save changes
            </ItemButton>
          </div>
        )}

        {isVoice && <ChannelVoiceSettings room={room} isAdmin={isAdmin} />}

        <div className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-text)]" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-semibold text-[var(--text)]">Promptly can read this room</span>
              <span className="text-xs leading-relaxed text-[var(--text-muted)]">{AI_CONTEXT_EXPLAINER}</span>
              {!isAdmin && (
                <span className="text-xs font-medium text-[var(--text)]">
                  {room.ai_context ? "It's on." : "It's off."} Only space admins can change this.
                </span>
              )}
            </div>
            {isAdmin && (
              <Toggle
                label="Promptly can read this room"
                checked={room.ai_context}
                onChange={(v) => void save({ ai_context: v }, v ? "Promptly can now read this room." : "Promptly only sees messages that mention it.")}
              />
            )}
          </div>
        </div>

        <NotifyRow room={room} space={space} />

        {isAdmin && (
          <div className="border-t border-[var(--border)] pt-4">
            <ItemButton
              variant="danger"
              icon={<Trash2 className="h-4 w-4" />}
              disabled={busy}
              onClick={async () => {
                const ok = await askInSheet({
                  title: isVoice ? `Delete ${room.name}?` : `Delete #${room.name}?`,
                  message: isVoice
                    ? "Anyone in it is disconnected, and its chat is deleted for everyone."
                    : "All its messages are deleted for everyone. This can't be undone.",
                  confirmLabel: isVoice ? "Delete channel" : "Delete room",
                  danger: true,
                });
                if (!ok) return;
                setBusy(true);
                try {
                  await roomsApi.deleteRoom(room.id);
                  removeRoom(qc, room.id);
                  onClose();
                  navigate("/rooms/");
                } catch (err) {
                  toast.error(apiErrorMessage(err, "Couldn't delete the room."));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {isVoice ? "Delete channel" : "Delete room"}
            </ItemButton>
          </div>
        )}
      </div>
    </Sheet>
  );
}

export function NewDmSheet({ open, onClose, b }: { open: boolean; onClose: () => void; b: Bootstrap }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [picked, setPicked] = useState<RoomUser[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setPicked([]);
  }, [open]);
  const start = async () => {
    if (!picked.length) return;
    setBusy(true);
    try {
      const room = await roomsApi.openDm(picked.map((u) => u.id));
      if (!upsertRoom(qc, { ...room, notify: room.notify ?? null })) await qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      // Make sure the people are known for names/avatars.
      qc.setQueryData<Bootstrap>(BOOTSTRAP_KEY, (cur) =>
        cur ? { ...cur, users: { ...cur.users, ...Object.fromEntries(picked.map((u) => [u.id, cur.users[u.id] ?? u])) } } : cur,
      );
      onClose();
      navigate(`/rooms/r/${room.id}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't start the conversation."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New message"
      footer={
        <ItemButton variant="primary" block disabled={!picked.length || busy} onClick={() => void start()}>
          {picked.length > 1 ? `Start group with ${picked.length} people` : "Start conversation"}
        </ItemButton>
      }
    >
      <p className="mb-3 text-sm text-[var(--text-muted)]">Pick one person, or a few for a small group. Only the people in it can read it.</p>
      <PeoplePicker selected={picked} onChange={setPicked} exclude={[b.me.id]} />
    </Sheet>
  );
}

export function DmSettingsSheet({ open, onClose, room, b }: { open: boolean; onClose: () => void; room: Room; b: Bootstrap }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const members = room.members ?? [];
  const aiOk = room.ai_ok ?? {};
  const allOn = members.length > 0 && members.every((id) => aiOk[id]);
  const mine = !!aiOk[b.me.id];

  const setMine = (v: boolean) => {
    const before = room.ai_ok;
    patchRoom(qc, room.id, (r) => ({ ...r, ai_ok: { ...(r.ai_ok ?? {}), [b.me.id]: v } }));
    roomsApi
      .updateMyRoom(room.id, { ai_ok: v })
      .then((r) => r && upsertRoom(qc, r))
      .catch((err) => {
        patchRoom(qc, room.id, (r) => ({ ...r, ai_ok: before }));
        toast.error(apiErrorMessage(err, "Couldn't change that."));
      });
  };

  return (
    <Sheet open={open} onClose={onClose} title={dmTitle(b, room)} size="md">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-text)]" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-sm font-semibold text-[var(--text)]">Let Promptly read this conversation</span>
              <span className="text-xs leading-relaxed text-[var(--text-muted)]">
                {AI_CONTEXT_EXPLAINER} In a conversation it's on only when <b>everyone</b> in it has switched it on.
              </span>
              <span className="text-xs font-medium text-[var(--text)]">{allOn ? "Everyone agreed — it's on." : "It's off for now."}</span>
            </div>
            <Toggle label="My consent: Promptly can read this conversation" checked={mine} onChange={setMine} />
          </div>
          <ul className="mt-1 flex flex-col gap-1.5 border-t border-[var(--border)] pt-3">
            {members.map((id) => (
              <li key={id} className="flex items-center gap-2 text-sm">
                <UserAvatar user={b.users[id]} size={24} />
                <span className="min-w-0 flex-1 truncate text-[var(--text)]">
                  {b.users[id]?.username ?? "Someone"}
                  {id === b.me.id && <span className="text-[var(--text-muted)]"> (you)</span>}
                </span>
                <span className={aiOk[id] ? "text-xs font-medium text-[var(--success)]" : "text-xs text-[var(--text-muted)]"}>
                  {aiOk[id] ? "Agreed" : "Not yet"}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <NotifyRow room={room} space={null} />

        <div className="border-t border-[var(--border)] pt-4">
          <ItemButton
            variant="secondary"
            icon={<EyeOff className="h-4 w-4" />}
            onClick={async () => {
              try {
                await roomsApi.updateMyRoom(room.id, { hidden: true });
                qc.setQueryData<Bootstrap>(BOOTSTRAP_KEY, (cur) => (cur ? { ...cur, dms: cur.dms.filter((r) => r.id !== room.id) } : cur));
                onClose();
                navigate("/rooms/dm");
                toast.success("Conversation closed. It comes back when someone writes.");
              } catch (err) {
                toast.error(apiErrorMessage(err, "Couldn't close it."));
              }
            }}
          >
            Close conversation
          </ItemButton>
          <p className="mt-1.5 text-xs text-[var(--text-muted)]">Hides it from your list. Nothing is deleted.</p>
        </div>
      </div>
    </Sheet>
  );
}
