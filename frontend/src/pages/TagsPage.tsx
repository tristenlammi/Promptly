import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookOpen,
  CalendarDays,
  CheckSquare,
  Contact as ContactIcon,
  File as FileIcon,
  GitMerge,
  Images,
  Pencil,
  Receipt,
  Tag as TagIcon,
  Trash2,
  UtensilsCrossed,
} from "lucide-react";

import { TAG_COLORS, tagColor, tagsApi, type Tag, type TaggedThing } from "@/api/tags";
import { TopNav } from "@/components/layout/TopNav";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { Skeleton } from "@/components/shared/Skeleton";
import { TAGS_KEY, TagChip, useTagSet } from "@/components/tags/TagPicker";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Tags (#tags): your one shared set — rename, recolour, merge, delete
 * (``/tags``) — and everything carrying one tag across apps
 * (``/tags/:tagId``), only what you can still open.
 */

const APP_ICON: Record<string, typeof FileIcon> = {
  file: FileIcon,
  event: CalendarDays,
  album: Images,
  task: CheckSquare,
  contact: ContactIcon,
  journal_entry: BookOpen,
  recipe: UtensilsCrossed,
  transaction: Receipt,
};

export function TagsPage() {
  const { data, isLoading } = useTagSet();
  const [filter, setFilter] = useState("");
  const tags = useMemo(
    () => (data ?? []).filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase())),
    [data, filter],
  );
  return (
    <>
      <TopNav title="Tags" subtitle="One set of tags across Tasks, Files, Calendar, Contacts, Recipes, Budget and Photos" />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          {(data?.length ?? 0) > 8 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tags…"
              aria-label="Filter tags"
              className="mb-4 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
          )}
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (data?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<TagIcon className="h-5 w-5" />}
              title="No tags yet"
              description="Add a tag to a task, contact, file, event or album and it shows up here — the same tag in every app."
            />
          ) : (
            <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
              {tags.map((t) => (
                <TagRow key={t.id} tag={t} all={data ?? []} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function TagRow({ tag, all }: { tag: Tag; all: Tag[] }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [merging, setMerging] = useState(false);
  const [picking, setPicking] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: TAGS_KEY });

  const rename = async () => {
    setEditing(false);
    const next = name.trim();
    if (!next || next === tag.name) return setName(tag.name);
    try {
      await tagsApi.update(tag.id, { name: next });
      refresh();
    } catch (e) {
      setName(tag.name);
      toast.error(apiErrorMessage(e, "Couldn't rename it — is there already a tag with that name? Merge them instead."));
    }
  };
  const recolor = async (color: string | null) => {
    try {
      await tagsApi.update(tag.id, { color });
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't change the colour."));
    }
  };
  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${tag.name}”?`,
      message: "It comes off everything it's on, in every app. The things themselves stay.",
      confirmLabel: "Delete tag",
      danger: true,
    });
    if (!ok) return;
    try {
      await tagsApi.remove(tag.id);
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't delete it."));
    }
  };
  const merge = async (into: Tag) => {
    setMerging(false);
    const ok = await confirm({
      title: `Merge “${tag.name}” into “${into.name}”?`,
      message: `Everything tagged ${tag.name} will be tagged ${into.name}, and ${tag.name} goes.`,
      confirmLabel: "Merge",
    });
    if (!ok) return;
    try {
      await tagsApi.merge(tag.id, into.id);
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't merge them."));
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setName(tag.name);
                setEditing(false);
              }
            }}
            maxLength={40}
            aria-label="Tag name"
            className="h-8 w-full max-w-xs rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        ) : (
          <TagChip tag={tag} />
        )}
      </div>
      <span className="text-xs text-[var(--text-muted)]">{tag.count ?? 0}</span>
      <div className="relative">
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="flex rounded p-1.5 hover:bg-[var(--hover)]"
          aria-label={`Colour of ${tag.name}`}
          title="Colour"
          aria-expanded={picking}
        >
          <span className="h-3.5 w-3.5 rounded-full" style={{ background: tagColor(tag) }} />
        </button>
        {picking && (
          <div className="absolute right-0 top-full z-20 mt-1 grid w-max grid-cols-7 gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg" role="group" aria-label="Colour">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setPicking(false);
                  void recolor(c);
                }}
                aria-label={`Colour ${c}`}
                aria-pressed={tagColor(tag) === c}
                className={cn("h-5 w-5 rounded-full border-2", tagColor(tag) === c ? "border-[var(--text)]" : "border-transparent")}
                style={{ background: c }}
              />
            ))}
          </div>
        )}
      </div>
      <button type="button" onClick={() => setEditing(true)} className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)]" aria-label={`Rename ${tag.name}`} title="Rename">
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <div className="relative">
        <button type="button" onClick={() => setMerging((v) => !v)} className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)]" aria-label={`Merge ${tag.name} into…`} title="Merge into…" aria-expanded={merging}>
          <GitMerge className="h-3.5 w-3.5" />
        </button>
        {merging && (
          <div className="absolute right-0 top-full z-20 mt-1 max-h-60 w-48 overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg">
            <div className="px-3 py-1 text-[11px] text-[var(--text-muted)]">Merge into…</div>
            {all.filter((o) => o.id !== tag.id).map((o) => (
              <button key={o.id} type="button" onClick={() => void merge(o)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--surface-2)]">
                <span className="h-2 w-2 rounded-full" style={{ background: tagColor(o) }} />
                <span className="truncate">{o.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" onClick={() => void remove()} className="rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]" aria-label={`Delete ${tag.name}`} title="Delete">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

export function TagPage() {
  const { tagId = "" } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQuery({ queryKey: ["tags", "items", tagId], queryFn: () => tagsApi.items(tagId), enabled: !!tagId });
  const groups = useMemo(() => {
    const out = new Map<string, TaggedThing[]>();
    for (const it of data?.items ?? []) {
      if (!out.has(it.app)) out.set(it.app, []);
      out.get(it.app)!.push(it);
    }
    return [...out.entries()];
  }, [data]);

  return (
    <>
      <TopNav
        title={data ? <TagChip tag={data.tag} link={false} className="h-8 text-sm" /> : "Tag"}
        subtitle="Everything with this tag, across your apps"
        actions={
          <Link to="/tags" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]">
            <ArrowLeft className="h-3.5 w-3.5" /> All tags
          </Link>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : isError ? (
            <EmptyState icon={<TagIcon className="h-5 w-5" />} title="No such tag" description="It may have been deleted or merged into another." />
          ) : groups.length === 0 ? (
            <EmptyState icon={<TagIcon className="h-5 w-5" />} title="Nothing here yet" description="Nothing you can open has this tag right now." />
          ) : (
            groups.map(([app, items]) => (
              <section key={app} className="mb-6">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {app} · {items.length}
                </h2>
                <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
                  {items.map((it) => {
                    const Icon = APP_ICON[it.kind] ?? FileIcon;
                    return (
                      <li key={`${it.kind}:${it.id}`}>
                        <button
                          type="button"
                          onClick={() => navigate(it.url)}
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-[var(--hover)]"
                        >
                          <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-[var(--text)]">{it.title}</span>
                            {it.detail && <span className="block truncate text-xs text-[var(--text-muted)]">{detail(it)}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function detail(it: TaggedThing): string {
  if (it.kind === "event") {
    const d = new Date(it.detail.length === 10 ? `${it.detail}T12:00:00` : it.detail);
    if (!Number.isNaN(d.getTime()))
      return d.toLocaleString([], it.detail.length === 10
        ? { weekday: "short", day: "numeric", month: "short", year: "numeric" }
        : { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  }
  return it.detail;
}
