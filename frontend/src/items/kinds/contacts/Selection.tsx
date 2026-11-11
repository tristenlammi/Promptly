import { Download, FolderPlus, Trash2, Users, X } from "lucide-react";
import { useState } from "react";

import { confirm } from "@/components/shared/ConfirmDialog";
import { ItemButton, Sheet, TextInput, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";

import { AVATAR_COLORS, removeContacts } from "./model";
import { downloadText, safeFilename, useHomeCountry, type Handle } from "./shared";
import { toVCards } from "./vcard";

/*
 * Several contacts picked at once: add them to a group, save them as a
 * file, or delete them (with Undo). The bar sits under the list while
 * picking is on.
 */

export function SelectionBar({
  item,
  title,
  picked,
  allIds,
  onPick,
  onDone,
}: {
  item: Handle;
  /** The file's name, for the export's filename. */
  title: string;
  picked: Set<string>;
  /** Everyone the list is showing right now (for "Select all"). */
  allIds: string[];
  onPick: (next: Set<string>) => void;
  onDone: () => void;
}) {
  const [grouping, setGrouping] = useState(false);
  const cc = useHomeCountry(item);
  const n = picked.size;
  const all = allIds.length > 0 && allIds.every((id) => picked.has(id));
  const who = (k: number) => `${k.toLocaleString()} ${k === 1 ? "contact" : "contacts"}`;

  const exportPicked = () => {
    const data = item.data;
    const chosen = data.contacts.filter((c) => picked.has(c.id));
    if (!chosen.length) return;
    const byId = new Map(data.contacts.map((c) => [c.id, c]));
    downloadText(`${safeFilename(title)} (${chosen.length}).vcf`, toVCards(chosen, data.groups, "3.0", byId, cc), "text/vcard;charset=utf-8");
    toast.success(`Saved ${who(chosen.length)} as a file`);
    onDone();
  };

  const deletePicked = async () => {
    const ids = new Set(picked);
    const copies = structuredClone(item.data.contacts.filter((c) => ids.has(c.id)));
    if (!copies.length) return;
    const ok = await confirm({
      title: `Delete ${who(copies.length)}?`,
      message: "Their details, notes and history go. They stay in the Trash for 30 days, so you can restore them.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    item.update((d) => removeContacts(d, ids));
    onDone();
    toast.success(`Deleted ${who(copies.length)}`, {
      action: {
        label: "Undo",
        onClick: () =>
          item.update((d) => {
            for (const c of copies) if (!d.contacts.some((x) => x.id === c.id)) d.contacts.push(c);
          }),
      },
    });
  };

  return (
    <div
      role="toolbar"
      aria-label="Selected contacts"
      className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-4px_12px_-8px_rgba(0,0,0,0.25)]"
    >
      <div className="flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-[var(--text)]" aria-live="polite">
          {n === 0 ? "Pick people" : `${n.toLocaleString()} selected`}
        </p>
        {allIds.length > 0 && (
          <button
            type="button"
            onClick={() => onPick(all ? new Set() : new Set(allIds))}
            className="inline-flex h-10 items-center rounded-lg px-2.5 text-sm font-medium text-[var(--item-accent)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          >
            {all ? "Select none" : "Select all"}
          </button>
        )}
        <button
          type="button"
          aria-label="Stop selecting"
          title="Done"
          onClick={onDone}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1 grid grid-flow-col auto-cols-fr gap-1.5">
        {item.canEdit && <BarButton icon={<FolderPlus className="h-4 w-4" />} label="Add to group" disabled={n === 0} onClick={() => setGrouping(true)} />}
        <BarButton icon={<Download className="h-4 w-4" />} label="Export" disabled={n === 0} onClick={exportPicked} />
        {item.canEdit && <BarButton icon={<Trash2 className="h-4 w-4" />} label="Delete" danger disabled={n === 0} onClick={() => void deletePicked()} />}
      </div>
      <GroupPicker
        item={item}
        open={grouping}
        count={n}
        onClose={() => setGrouping(false)}
        onAdded={() => {
          setGrouping(false);
          onDone();
        }}
        picked={picked}
      />
    </div>
  );
}

function BarButton({ icon, label, onClick, disabled, danger }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        "inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-2 text-sm font-medium transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] disabled:opacity-45 disabled:hover:bg-transparent md:h-10 " +
        (danger ? "text-[var(--danger,#dc2626)]" : "text-[var(--text)]")
      }
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function GroupPicker({ item, open, count, picked, onClose, onAdded }: { item: Handle; open: boolean; count: number; picked: Set<string>; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const groups = item.data.groups;

  const add = (groupId: string | null, label: string) => {
    const ids = new Set(picked);
    const newId = uid("g");
    const now = new Date().toISOString();
    const fresh = label.trim().slice(0, 60);
    if (!groupId && !fresh) return;
    item.update((d) => {
      let gid = groupId;
      if (!gid) {
        // Typed the name of a group that's already there: use that one.
        const same = d.groups.find((g) => g.name.toLowerCase() === fresh.toLowerCase() || g.id === newId);
        if (same) gid = same.id;
        else {
          d.groups.push({ id: newId, name: fresh, color: AVATAR_COLORS[d.groups.length % AVATAR_COLORS.length], description: "" });
          gid = newId;
        }
      } else if (!d.groups.some((g) => g.id === gid)) return;
      for (const c of d.contacts) {
        if (!ids.has(c.id) || c.groups.includes(gid)) continue;
        c.groups.push(gid);
        c.updated_at = now;
      }
    });
    setName("");
    toast.success(`Added ${count.toLocaleString()} ${count === 1 ? "person" : "people"} to ${groupId ? label : fresh}`);
    onAdded();
  };

  return (
    <Sheet open={open} onClose={onClose} size="sm" title={`Add ${count.toLocaleString()} ${count === 1 ? "person" : "people"} to a group`}>
      <div className="flex flex-col gap-3">
        {groups.length > 0 && (
          <ul className="overflow-hidden rounded-xl border border-[var(--border)]">
            {groups.map((g, i) => (
              <li key={g.id} className={i > 0 ? "border-t border-[var(--border)]" : undefined}>
                <button
                  type="button"
                  onClick={() => add(g.id, g.name)}
                  className="flex min-h-[48px] w-full items-center gap-3 px-3 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: g.color ?? AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                    <Users className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add(null, name);
          }}
        >
          <label className="min-w-0 flex-1 text-xs font-medium text-[var(--text-muted)]">
            {groups.length > 0 ? "Or start a new group" : "Start a new group"}
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Family, work, the climbing crew" maxLength={60} className="mt-1" />
          </label>
          <ItemButton type="submit" variant="primary" disabled={!name.trim()}>
            Add
          </ItemButton>
        </form>
      </div>
    </Sheet>
  );
}
