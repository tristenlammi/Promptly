import { LogOut, Trash2, UserPlus, X } from "lucide-react";
import { useState } from "react";

import { calendarApi, type CalUser, type Calendar, type CalendarBootstrap, type ShareRole } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Field, ItemButton, Select, Sheet, TextInput } from "@/items/ui";
import { PeoplePicker } from "@/rooms/components/PeoplePicker";
import { UserAvatar } from "@/rooms/components/ui";
import { toast } from "@/store/toastStore";

import { addUsers, useCalUsers, useRefreshCalendars } from "../data";
import { CAL_ACCENT } from "../model";
import { Swatches } from "./ui";

/** New shared calendar. */
export function NewCalendarSheet({ open, onClose, b }: { open: boolean; onClose: () => void; b: CalendarBootstrap }) {
  const refresh = useRefreshCalendars();
  const [name, setName] = useState("");
  const [color, setColor] = useState(CAL_ACCENT);
  const [people, setPeople] = useState<CalUser[]>([]);
  const [saving, setSaving] = useState(false);
  const close = () => {
    setName("");
    setColor(CAL_ACCENT);
    setPeople([]);
    onClose();
  };
  const create = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await calendarApi.createCalendar({ name: name.trim(), color, member_ids: people.map((p) => p.id) });
      toast.success(`"${name.trim()}" created`);
      refresh();
      close();
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={close}
      title="New shared calendar"
      footer={
        <>
          <ItemButton block onClick={close}>
            Cancel
          </ItemButton>
          <ItemButton block variant="primary" disabled={!name.trim() || saving} onClick={() => void create()}>
            {saving ? "Creating…" : "Create"}
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        <Field label="Name">
          <TextInput data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Family" maxLength={80} onKeyDown={(e) => e.key === "Enter" && void create()} />
        </Field>
        <Field label="Colour">
          <Swatches value={color} onChange={setColor} />
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">People (they can add and change events — you can make someone view-only later)</span>
          <PeoplePicker selected={people} onChange={setPeople} exclude={[b.me.id]} />
        </div>
      </div>
    </Sheet>
  );
}

/** What each sharing level lets someone do. */
export const ROLE_LABEL: Record<ShareRole, string> = {
  busy: "Free/busy only",
  viewer: "See all details",
  editor: "Make changes",
};
const ROLE_HELP: Record<ShareRole, string> = {
  busy: "Sees when you're busy — never what, or where.",
  viewer: "Sees your events and their details.",
  editor: "Sees everything and can add and change events.",
};

/** A calendar's settings and people: a shared one's (owner), sharing your
 * own ("Share my calendar"), or what you were given (everyone else). */
export function CalendarSettingsSheet({ cal, onClose, b }: { cal: Calendar | null; onClose: () => void; b: CalendarBootstrap }) {
  const own = !!cal && cal.personal && cal.role === "owner";
  return (
    <Sheet open={!!cal} onClose={onClose} title={cal ? (own ? "Share my calendar" : cal.name) : ""}>
      {cal && <SettingsBody key={cal.id} cal={cal} onClose={onClose} b={b} />}
    </Sheet>
  );
}

function SettingsBody({ cal, onClose, b }: { cal: Calendar; onClose: () => void; b: CalendarBootstrap }) {
  const refresh = useRefreshCalendars();
  const users = useCalUsers((s) => s.users);
  const owner = cal.role === "owner";
  const [name, setName] = useState(cal.name);
  const [color, setColor] = useState(cal.base_color);
  const own = cal.personal && owner;
  const [adding, setAdding] = useState(own && Object.keys(cal.member_roles).length <= 1);
  const [toAdd, setToAdd] = useState<CalUser[]>([]);
  const [addRole, setAddRole] = useState<ShareRole>(cal.personal ? "viewer" : "editor");
  const [busy, setBusy] = useState(false);
  // Your own calendar lists who you shared it with (you're implied).
  const members = Object.entries(cal.member_roles).filter(([uid]) => !(own && uid === b.me.id));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      refresh();
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setBusy(false);
    }
  };

  const saveDetails = () =>
    run(async () => {
      await calendarApi.updateCalendar(cal.id, { name: name.trim() || cal.name, color });
      toast.success("Saved");
    });

  const add = () =>
    run(async () => {
      const r = await calendarApi.addMembers(cal.id, toAdd.map((u) => u.id), addRole);
      addUsers(r.users);
      if (own) toast.success(toAdd.length === 1 ? `Shared with ${toAdd[0].username}` : `Shared with ${toAdd.length} people`);
      setToAdd([]);
      setAdding(false);
    });

  const removeMember = (uid: string) =>
    run(async () => {
      const who = users[uid]?.username ?? "them";
      const what = own ? "your calendar" : `"${cal.name}"`;
      if (!(await confirm({ title: own ? "Stop sharing?" : "Remove from calendar?", message: `${who} won't see ${what} any more.`, confirmLabel: own ? "Stop sharing" : "Remove", danger: true }))) return;
      await calendarApi.removeMember(cal.id, uid);
    });

  const leave = () =>
    run(async () => {
      const theirs = cal.personal;
      if (
        !(await confirm({
          title: theirs ? `Remove ${cal.name}?` : `Leave "${cal.name}"?`,
          message: theirs ? "It won't show next to yours any more. They can share it with you again." : "Its events will disappear from your calendar. Someone on it can add you back.",
          confirmLabel: theirs ? "Remove" : "Leave",
          danger: true,
        }))
      )
        return;
      await calendarApi.removeMember(cal.id, b.me.id);
      toast.success(theirs ? `Removed ${cal.name}` : `Left "${cal.name}"`);
      onClose();
    });

  const del = () =>
    run(async () => {
      if (!(await confirm({ title: `Delete "${cal.name}"?`, message: "Every event on it is deleted for everyone. This can't be undone.", confirmLabel: "Delete calendar", danger: true }))) return;
      await calendarApi.deleteCalendar(cal.id);
      toast.success("Calendar deleted");
      onClose();
    });

  const dirty = name.trim() !== cal.name || color.toLowerCase() !== cal.base_color.toLowerCase();

  return (
    <div className="flex flex-col gap-5 pt-1">
      {owner && !cal.personal && (
        <div className="flex flex-col gap-3">
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Colour (for everyone, unless they pick their own)">
            <Swatches value={color} onChange={setColor} />
          </Field>
          {dirty && (
            <ItemButton variant="primary" onClick={() => void saveDetails()} disabled={busy || !name.trim()}>
              Save changes
            </ItemButton>
          )}
        </div>
      )}

      {own && (
        <p className="text-sm text-[var(--text-muted)]">
          Choose who can see your calendar — your partner, family. It shows next to theirs as “{b.me.username}'s calendar”. They don't get your reminders.
        </p>
      )}
      {cal.personal && !owner && (
        <p className="text-sm text-[var(--text-muted)]">
          Shared with you by {users[cal.owner_id ?? ""]?.username ?? "its owner"} · {ROLE_LABEL[cal.role as ShareRole] ?? ""}. {ROLE_HELP[cal.role as ShareRole] ?? ""}
        </p>
      )}

      {(owner || !cal.personal) && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-muted)]">
              {own ? (members.length ? `Shared with ${members.length} ${members.length === 1 ? "person" : "people"}` : "Only you can see it") : `${members.length} ${members.length === 1 ? "person" : "people"}`}
            </span>
            {owner && (
              <ItemButton size="sm" variant="ghost" icon={<UserPlus className="h-3.5 w-3.5" />} onClick={() => setAdding((x) => !x)}>
                {own ? "Share with…" : "Add people"}
              </ItemButton>
            )}
          </div>
          {adding && (
            <div className="flex flex-col gap-2.5 rounded-xl border border-[var(--border)] p-2.5">
              <PeoplePicker selected={toAdd} onChange={setToAdd} exclude={Object.keys(cal.member_roles)} />
              <Field label="They can">
                <Select value={addRole} onChange={(e) => setAddRole(e.target.value as ShareRole)}>
                  {(["busy", "viewer", "editor"] as const).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="-mt-1 text-xs text-[var(--text-muted)]">{ROLE_HELP[addRole]}</p>
              <ItemButton variant="primary" disabled={!toAdd.length || busy} onClick={() => void add()}>
                {own ? "Share" : "Add"} {toAdd.length > 1 ? `with ${toAdd.length}` : ""}
              </ItemButton>
            </div>
          )}
          {members.length > 0 && (
          <ul className="flex flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {members.map(([uid, role]) => {
              const u = users[uid];
              return (
                <li key={uid} className="flex min-h-12 items-center gap-2 px-3 py-1.5">
                  <UserAvatar user={u ?? { id: uid, username: "?", avatar_url: null, color: null }} size={28} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
                    {uid === b.me.id ? "You" : (u?.username ?? "Someone")}
                  </span>
                  {role === "owner" ? (
                    <span className="text-xs text-[var(--text-muted)]">Owner</span>
                  ) : owner ? (
                    <>
                      <Select
                        value={role}
                        disabled={busy}
                        onChange={(e) => void run(() => calendarApi.setRole(cal.id, uid, e.target.value as ShareRole).then(() => undefined))}
                        className="!h-9 !w-auto !text-xs"
                        aria-label="What they can do"
                      >
                        {(["busy", "viewer", "editor"] as const).map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </Select>
                      <button
                        type="button"
                        aria-label={`Remove ${u?.username ?? "member"}`}
                        onClick={() => void removeMember(uid)}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-[var(--text-muted)]">{ROLE_LABEL[role as ShareRole] ?? role}</span>
                  )}
                </li>
              );
            })}
          </ul>
          )}
        </div>
      )}

      {!own && (
        <div className="border-t border-[var(--border)] pt-3">
          {owner ? (
            <ItemButton variant="ghost" className="text-[var(--danger)]" icon={<Trash2 className="h-4 w-4" />} onClick={() => void del()} disabled={busy}>
              Delete calendar
            </ItemButton>
          ) : (
            <ItemButton variant="ghost" className="text-[var(--danger)]" icon={<LogOut className="h-4 w-4" />} onClick={() => void leave()} disabled={busy}>
              {cal.personal ? "Remove from my calendars" : "Leave calendar"}
            </ItemButton>
          )}
        </div>
      )}
    </div>
  );
}
