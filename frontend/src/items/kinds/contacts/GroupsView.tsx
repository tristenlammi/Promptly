import { FolderPlus, Hash, Pencil, Settings2, Trash2, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, Field, ItemButton, List, ListRow, Page, Section, Sheet, TextArea, TextInput, uid } from "@/items/ui";
import type { ItemViewProps } from "@/items/types";
import { cn } from "@/utils/cn";

import { AVATAR_COLORS, buildIndex, displayName, groupCounts, matches, sortContacts, tagCounts } from "./model";
import { ContactAvatar, setPendingFilter, type Handle } from "./shared";
import { ToolsMenu } from "./ToolsMenu";
import type { Contact, ContactsData, Group } from "./types";

/* Groups & tags. (Import, export, duplicates and settings live under "More".) */

export function GroupsView({ item, goTo, ask, doc, isPhone }: ItemViewProps<ContactsData>) {
  const data = item.data;
  const counts = useMemo(() => groupCounts(data), [data]);
  const members = useMemo(() => {
    const m = new Map<string, Contact[]>();
    for (const c of data.contacts) for (const g of c.groups) m.set(g, [...(m.get(g) ?? []), c]);
    return m;
  }, [data.contacts]);
  const tags = useMemo(() => tagCounts(data), [data]);
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [tagEdit, setTagEdit] = useState<string | null>(null);
  const can = item.canEdit;

  return (
    <Page wide>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-5">
          <Section
            title="Groups"
            hint="Family, work, the climbing crew — a person can be in several."
            action={can && <ItemButton size="sm" className="shrink-0 whitespace-nowrap" icon={<FolderPlus className="h-4 w-4" />} onClick={() => setEditing("new")}>New group</ItemButton>}
          >
            {data.groups.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No groups yet"
                text="Groups make it easy to find and export people together."
                action={
                  can && (
                    <div className="flex flex-wrap justify-center gap-2">
                      <ItemButton variant="primary" onClick={() => setEditing("new")}>
                        Create a group
                      </ItemButton>
                      <ItemButton variant="ghost" onClick={() => ask("Suggest sensible groups for my contacts from their companies, tags and notes, and sort people into them.")}>
                        Suggest groups
                      </ItemButton>
                    </div>
                  )
                }
              />
            ) : (
              <List>
                {data.groups.map((g, gi) => {
                  const people = members.get(g.id) ?? [];
                  return (
                    <ListRow
                      key={g.id}
                      onClick={() => {
                        setPendingFilter({ kind: "group", id: g.id });
                        goTo("people");
                      }}
                      leading={
                        <span className="flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ background: g.color ?? AVATAR_COLORS[gi % AVATAR_COLORS.length] }}>
                          <Users className="h-[18px] w-[18px]" />
                        </span>
                      }
                      title={g.name}
                      subtitle={g.description || `${counts.get(g.id) ?? 0} ${(counts.get(g.id) ?? 0) === 1 ? "person" : "people"}`}
                      trailing={
                        !isPhone && people.length > 0 && (
                          <span className="flex items-center" aria-hidden>
                            {people.slice(0, 3).map((c, i) => (
                              <ContactAvatar key={c.id} contact={c} size={26} className={cn("ring-2 ring-[var(--surface)]", i > 0 && "-ml-2")} />
                            ))}
                            {people.length > 3 && <span className="ml-1.5 text-xs tabular-nums text-[var(--text-muted)]">+{people.length - 3}</span>}
                          </span>
                        )
                      }
                      action={
                        can && (
                          <button type="button" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g)} className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]">
                            <Pencil className="h-4 w-4" />
                          </button>
                        )
                      }
                    />
                  );
                })}
              </List>
            )}
          </Section>

          <Section title="Tags" hint={tags.length ? "Tap a tag to see who has it." : undefined}>
            {tags.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
                Tags are quick labels — “climbing”, “neighbours”, “investor”. Add them when editing someone.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {tags.map(([t, n]) => (
                  <span key={t} className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface)]">
                    <button
                      type="button"
                      onClick={() => {
                        setPendingFilter({ kind: "tag", tag: t });
                        goTo("people");
                      }}
                      className="inline-flex h-9 items-center gap-1.5 rounded-l-full pl-3 pr-2 text-sm text-[var(--text)] hover:bg-[var(--hover)]"
                    >
                      <Hash className="h-3.5 w-3.5 text-[var(--item-accent)]" />
                      {t}
                      <span className="text-xs tabular-nums text-[var(--text-muted)]">{n}</span>
                    </button>
                    {can && (
                      <button type="button" aria-label={`Edit tag ${t}`} onClick={() => setTagEdit(t)} className="flex h-9 w-9 items-center justify-center rounded-r-full text-[var(--text-muted)] hover:bg-[var(--hover)]">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
          </Section>
        </div>

        <Section title="More" hint="Import, export, duplicates and settings. They are also under More on the Contacts tab.">
          <ToolsMenu item={item} title={doc.title} ask={ask} className="self-start" align="left" />
          <p className="flex items-center gap-1.5 px-1 text-xs text-[var(--text-muted)]">
            <Settings2 className="h-3.5 w-3.5" /> {data.contacts.length.toLocaleString()} people · {data.groups.length} groups · {tags.length} tags
          </p>
        </Section>
      </div>

      <GroupSheet item={item} group={editing} onClose={() => setEditing(null)} />
      <TagSheet item={item} tag={tagEdit} onClose={() => setTagEdit(null)} />
    </Page>
  );
}

function GroupSheet({ item, group, onClose }: { item: Handle; group: Group | "new" | null; onClose: () => void }) {
  const isNew = group === "new";
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [desc, setDesc] = useState("");
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!group) return;
    if (group === "new") {
      setName("");
      setColor(null);
      setDesc("");
      setMembers(new Set());
    } else {
      setName(group.name);
      setColor(group.color);
      setDesc(group.description);
      setMembers(new Set(item.data.contacts.filter((c) => c.groups.includes(group.id)).map((c) => c.id)));
    }
    setQ("");
    setConfirmDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);
  const index = useMemo(() => (group ? buildIndex(item.data) : null), [group, item.data]);
  const list = useMemo(() => {
    if (!index) return [];
    const all = sortContacts(item.data.contacts, item.data.settings.sort_by);
    const hits = q.trim() ? all.filter((c) => matches(index, c.id, q)) : [...all.filter((c) => members.has(c.id)), ...all.filter((c) => !members.has(c.id))];
    return hits.slice(0, 200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, q, item.data.contacts]);
  if (!group) return null;
  const save = () => {
    const n = name.trim().slice(0, 60);
    if (!n) return;
    // Decided from what the person saw: who they added and who they took out.
    const before = isNew ? new Set<string>() : new Set(item.data.contacts.filter((c) => c.groups.includes((group as Group).id)).map((c) => c.id));
    const joined = [...members].filter((id) => !before.has(id));
    const left = [...before].filter((id) => !members.has(id));
    const newId = uid("g");
    const now = new Date().toISOString();
    const original = isNew ? null : (group as Group);
    item.update((d) => {
      let g = original ? d.groups.find((x) => x.id === original.id) : undefined;
      if (!g) {
        if (!original && d.groups.some((x) => x.id === newId)) g = d.groups.find((x) => x.id === newId);
        else {
          g = { id: newId, name: n, color, description: desc.trim().slice(0, 300) };
          d.groups.push(g);
        }
      }
      if (g && original) {
        if (n !== original.name) g.name = n;
        if (color !== original.color) g.color = color;
        if (desc.trim() !== original.description) g.description = desc.trim().slice(0, 300);
      }
      if (!g) return;
      const gid = g.id;
      for (const c of d.contacts) {
        const has = c.groups.includes(gid);
        if (joined.includes(c.id) && !has) {
          c.groups.push(gid);
          c.updated_at = now;
        } else if (left.includes(c.id) && has) {
          c.groups = c.groups.filter((x) => x !== gid);
          c.updated_at = now;
        }
      }
    });
    onClose();
  };
  const remove = () => {
    if (isNew) return;
    const gid = (group as Group).id;
    item.update((d) => {
      d.groups = d.groups.filter((g) => g.id !== gid);
      for (const c of d.contacts) c.groups = c.groups.filter((x) => x !== gid);
    });
    onClose();
  };
  return (
    <Sheet
      open={!!group}
      onClose={onClose}
      size="lg"
      title={isNew ? "New group" : "Edit group"}
      footer={
        <>
          {!isNew &&
            (confirmDelete ? (
              <ItemButton variant="danger" onClick={remove}>
                Delete group
              </ItemButton>
            ) : (
              <ItemButton variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmDelete(true)}>
                Delete
              </ItemButton>
            ))}
          <ItemButton variant="primary" block disabled={!name.trim()} onClick={save}>
            Save · {members.size} {members.size === 1 ? "person" : "people"}
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Family" />
        </Field>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={`Colour ${c}`}
              onClick={() => setColor(c)}
              className={cn("h-8 w-8 rounded-full border-2", color === c ? "border-[var(--text)]" : "border-transparent")}
              style={{ background: c }}
            />
          ))}
        </div>
        <Field label="Description (optional)">
          <TextArea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <Field label="Members">
          <TextInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find people to add" />
        </Field>
        <ul className="max-h-[40vh] divide-y divide-[var(--border)] overflow-y-auto rounded-2xl border border-[var(--border)]">
          {list.map((c) => {
            const on = members.has(c.id);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() =>
                    setMembers((s) => {
                      const n = new Set(s);
                      if (n.has(c.id)) n.delete(c.id);
                      else n.add(c.id);
                      return n;
                    })
                  }
                  className="flex min-h-[48px] w-full items-center gap-3 px-3 text-left hover:bg-[var(--hover)]"
                >
                  <ContactAvatar contact={c} size={30} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{displayName(c)}</span>
                  <span className={cn("h-5 w-5 rounded-md border", on ? "border-[var(--item-accent)] bg-[var(--item-accent-fill)]" : "border-[var(--border)]")} aria-hidden />
                </button>
              </li>
            );
          })}
          {list.length === 0 && <li className="px-3 py-4 text-sm text-[var(--text-muted)]">No one matches.</li>}
        </ul>
      </div>
    </Sheet>
  );
}

function TagSheet({ item, tag, onClose }: { item: Handle; tag: string | null; onClose: () => void }) {
  const [name, setName] = useState("");
  useEffect(() => setName(tag ?? ""), [tag]);
  if (tag === null) return null;
  const same = (t: string) => t.toLowerCase() === tag.toLowerCase();
  const rename = () => {
    const n = name.trim().slice(0, 40);
    if (!n) return;
    item.update((d) => {
      for (const c of d.contacts)
        if (c.tags.some(same)) {
          const rest = c.tags.filter((t) => !same(t));
          c.tags = rest.some((t) => t.toLowerCase() === n.toLowerCase()) ? rest : [...rest, n];
        }
    });
    onClose();
  };
  const remove = () => {
    item.update((d) => {
      for (const c of d.contacts) c.tags = c.tags.filter((t) => !same(t));
    });
    onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      size="sm"
      title={`Tag “${tag}”`}
      footer={
        <>
          <ItemButton variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={remove}>
            Remove from everyone
          </ItemButton>
          <ItemButton variant="primary" block disabled={!name.trim() || name.trim() === tag} onClick={rename}>
            Rename
          </ItemButton>
        </>
      }
    >
      <Field label="Name">
        <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </Sheet>
  );
}

