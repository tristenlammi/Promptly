import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, EyeOff, Loader2, Plus, Search, Sparkles } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";

import { extractError } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { itemsApi, type StoreItem } from "./api";
import { itemIcon } from "./registry";
import { fmtAgo } from "./ui/format";
import { Sheet } from "./ui/Sheet";
import "./ui/items.css";

/**
 * ``/files/store`` — the Item Store. Everything is free and nothing is on
 * by default: "Get" adds an item to your New menus; opening it makes your
 * first file. Admins can hide an item from everyone.
 */
export function StorePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ["item-store"], queryFn: itemsApi.store });
  const { data: mine } = useQuery({ queryKey: ["item-files"], queryFn: () => itemsApi.list() });
  const [category, setCategory] = useState<string>("All");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<StoreItem | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  const items = data?.items ?? [];
  const categories = useMemo(() => ["All", ...Array.from(new Set(items.map((i) => i.category)))], [items]);
  const shown = items.filter(
    (i) =>
      (category === "All" || i.category === category) &&
      (!q.trim() || `${i.name} ${i.tagline} ${i.replaces}`.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const byKind = useMemo(() => Object.fromEntries(items.map((i) => [i.kind, i])), [items]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["item-store"] });
    void qc.invalidateQueries({ queryKey: ["item-files"] });
    void qc.invalidateQueries({ queryKey: ["installed-items"] });
  };

  const add = useMutation({
    mutationFn: (kind: string) => itemsApi.add(kind),
    onSuccess: refresh,
    onError: (e) => toast.error(extractError(e)),
  });
  const remove = useMutation({
    mutationFn: (kind: string) => itemsApi.remove(kind),
    onSuccess: refresh,
    onError: (e) => toast.error(extractError(e)),
  });
  const hide = useMutation({
    mutationFn: (disabled: string[]) => itemsApi.setDisabled(disabled),
    onSuccess: refresh,
    onError: (e) => toast.error(extractError(e)),
  });

  const start = async (it: StoreItem) => {
    setCreating(it.kind);
    try {
      if (!it.installed) await itemsApi.add(it.kind);
      // One app = one file: open it (made the first time).
      const { file_id } = await itemsApi.openApp(it.kind);
      refresh();
      navigate(`/apps/${it.kind}/${file_id}`);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setCreating(null);
    }
  };

  const disabledKinds = items.filter((i) => i.disabled).map((i) => i.kind);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-5 md:px-8 md:py-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-[var(--text)]">
            <Sparkles className="h-6 w-6 text-[var(--accent)]" /> Item Store
          </h1>
          <p className="max-w-xl text-sm text-[var(--text-muted)]">
            Apps that live in your files — each one keeps everything in a single file you own, with an assistant
            built in, and your chats know about them too. All free.
          </p>
        </div>
        <label className="relative w-full md:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search items"
            aria-label="Search items"
            className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
        </label>
      </header>

      {!!mine?.length && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-[var(--text)]">Your items</h2>
          <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:grid md:grid-cols-4 md:px-0">
            {mine.slice(0, 8).map((f) => {
              const it = byKind[f.kind];
              const Icon = itemIcon(it?.icon);
              return (
                <button
                  key={f.file_id}
                  type="button"
                  onClick={() => navigate(`/files/item/${f.file_id}`)}
                  className="flex min-w-[200px] items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition hover:border-[var(--accent)]"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: it?.color ?? "var(--accent)" }}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-[var(--text)]">{f.title}</span>
                    <span className="block truncate text-xs text-[var(--text-muted)]">
                      {it?.name ?? f.kind} · {fmtAgo(f.updated_at)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            aria-pressed={c === category}
            className={cn(
              "h-8 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition",
              c === category
                ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--text)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16 text-[var(--text-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : shown.length === 0 ? (
        <p className="py-16 text-center text-sm text-[var(--text-muted)]">
          {items.length ? "Nothing matches." : "No items are available on this server yet."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((it) => {
            const Icon = itemIcon(it.icon);
            return (
              <article
                key={it.kind}
                style={{ "--item-accent": it.color, "--item-accent-fill": it.color } as CSSProperties}
                className={cn(
                  "group flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition hover:border-[var(--item-accent)] hover:shadow-[var(--shadow-md)]",
                  it.disabled && "opacity-60",
                )}
              >
                <button type="button" onClick={() => setOpen(it)} className="flex items-start gap-3 text-left">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-[var(--shadow-sm)]" style={{ background: it.color }}>
                    <Icon className="h-6 w-6" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[15px] font-semibold text-[var(--text)]">
                      {it.name}
                      {it.disabled && <EyeOff className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-label="Hidden from everyone" />}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-sm text-[var(--text-muted)]">{it.tagline}</span>
                  </span>
                </button>
                <div className="mt-auto flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-[var(--text-muted)]">
                    {it.installed ? (it.files ? `${it.files} file${it.files === 1 ? "" : "s"}` : "Added") : it.category}
                  </span>
                  {it.installed ? (
                    <button
                      type="button"
                      onClick={() => void start(it)}
                      disabled={creating === it.kind}
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--border)] px-3 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)]"
                    >
                      {creating === it.kind ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Open
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => add.mutate(it.kind)}
                      disabled={add.isPending || it.disabled}
                      className="inline-flex h-8 items-center rounded-lg bg-[var(--item-accent-fill)] px-4 text-xs font-semibold text-white hover:brightness-95 disabled:opacity-50"
                    >
                      Get
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.name} size="md">
        {open && (
          <div style={{ "--item-accent": open.color, "--item-accent-fill": open.color } as CSSProperties} className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              {(() => {
                const Icon = itemIcon(open.icon);
                return (
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: open.color }}>
                    <Icon className="h-7 w-7" />
                  </span>
                );
              })()}
              <div className="min-w-0">
                <p className="text-sm text-[var(--text)]">{open.tagline}</p>
                {open.replaces && <p className="text-xs text-[var(--text-muted)]">{open.replaces}</p>}
              </div>
            </div>
            <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--text)]">{open.description}</p>
            {!!open.highlights.length && (
              <ul className="flex flex-col gap-1.5">
                {open.highlights.map((h) => (
                  <li key={h} className="flex items-start gap-2 text-sm text-[var(--text)]">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--item-accent)]" />
                    {h}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                onClick={() => void start(open)}
                disabled={creating === open.kind || open.disabled}
                className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--item-accent-fill)] px-4 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50"
              >
                {creating === open.kind && <Loader2 className="h-4 w-4 animate-spin" />}
                {open.installed ? `Open ${open.name}` : `Get ${open.name}`}
              </button>
              {open.installed && (
                <button
                  type="button"
                  onClick={() => {
                    remove.mutate(open.kind);
                    setOpen(null);
                    toast.info(`${open.name} removed from your apps — its data stays in My files › Apps.`);
                  }}
                  className="inline-flex h-11 items-center rounded-xl border border-[var(--border)] px-4 text-sm text-[var(--text)] hover:bg-[var(--hover)]"
                >
                  Remove
                </button>
              )}
            </div>
            {data?.is_admin && (
              <label className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-3 text-sm">
                <span>
                  <span className="block font-medium text-[var(--text)]">Hide from everyone</span>
                  <span className="block text-xs text-[var(--text-muted)]">Admin: nobody can get it; existing files stay readable.</span>
                </span>
                <input
                  type="checkbox"
                  checked={open.disabled}
                  onChange={(e) => {
                    const next = e.target.checked ? [...disabledKinds, open.kind] : disabledKinds.filter((k) => k !== open.kind);
                    hide.mutate(next);
                    setOpen({ ...open, disabled: e.target.checked });
                  }}
                  className="h-5 w-5 accent-[var(--accent)]"
                />
              </label>
            )}
          </div>
        )}
      </Sheet>
    </div>
  );
}
