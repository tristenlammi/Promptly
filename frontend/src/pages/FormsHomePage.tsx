import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Copy, ExternalLink, Loader2, MoreVertical, Plus, Search, Star, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { filesApi } from "@/api/files";
import { formsApi, type FormCard, type FormTemplateInfo } from "@/api/forms";
import { formBuilderPath } from "@/lib/forms";
import { Menu, MenuItem } from "@/components/forms/builder/ui";
import { HeaderArt, isBuiltinHeader } from "@/components/forms/headers";
import { themeVars } from "@/components/forms/theme";
import "@/components/forms/forms.css";
import { extractError, formatRelativeTime } from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { ErrorState } from "@/components/shared/Callout";
import { Skeleton } from "@/components/shared/Skeleton";
import { invalidateFileQueries } from "@/hooks/useFiles";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Sheet } from "@/items/ui/Sheet";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

/**
 * Forms home, ``/forms`` (WP-F1.2): start a new form (blank or from a
 * template), and your forms with their answers — "12 answers · 3 new",
 * open or closed, when it closes. Forms are ordinary files, so a form made
 * in any Files folder shows here; one made here goes in the Forms folder.
 * Mine / Shared with me, and a search by title.
 */
export function FormsHomePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isPhone = useIsMobile();
  const [scope, setScope] = useState<"mine" | "shared">("mine");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const list = useQuery({ queryKey: ["forms-home", scope], queryFn: () => formsApi.list(scope), staleTime: 15_000 });
  const templates = useQuery({ queryKey: ["form-templates"], queryFn: formsApi.templates, staleTime: 5 * 60_000 });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = list.data ?? [];
    return needle ? rows.filter((f) => f.title.toLowerCase().includes(needle)) : rows;
  }, [list.data, q]);

  const create = async (key: string, payload: { template?: string; template_id?: string }) => {
    if (creating) return;
    setCreating(key);
    try {
      const file = await formsApi.create(payload);
      invalidateFileQueries(qc);
      qc.invalidateQueries({ queryKey: ["forms-home"] });
      navigate(formBuilderPath(file.id));
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setCreating(null);
      setSheetOpen(false);
    }
  };

  const starters = (
    <StartStrip
      templates={templates.data?.built_in ?? []}
      mine={templates.data?.mine ?? []}
      creating={creating}
      onCreate={create}
      vertical={isPhone}
    />
  );

  return (
    <>
      <TopNav title="Forms" />
      <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-5 pb-28 sm:px-6">
          {!isPhone && (
            <section aria-labelledby="forms-start">
              <h2 id="forms-start" className="mb-2 text-sm font-semibold text-[var(--text)]">
                Start a new form
              </h2>
              {starters}
            </section>
          )}

          <section aria-label="Your forms" className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div role="tablist" aria-label="Whose forms" className="flex rounded-lg border border-[var(--border)] p-0.5">
                {(["mine", "shared"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="tab"
                    aria-selected={scope === s}
                    onClick={() => setScope(s)}
                    className={cn(
                      "min-h-[36px] flex-1 rounded-md px-3 text-sm font-medium sm:flex-none",
                      scope === s ? "bg-[var(--accent-strong)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"
                    )}
                  >
                    {s === "mine" ? "Mine" : "Shared with me"}
                  </button>
                ))}
              </div>
              <span className="flex-1" />
              <label className="relative sm:w-64">
                <span className="sr-only">Search forms by title</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search forms"
                  className="h-10 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-sm focus:border-[var(--accent)] focus:outline-none"
                />
              </label>
            </div>

            {list.isLoading ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-40 w-full" />
                ))}
              </div>
            ) : list.isError ? (
              <ErrorState>
                Your forms couldn&apos;t be loaded.{" "}
                <button type="button" className="font-medium underline" onClick={() => void list.refetch()}>
                  Try again
                </button>
              </ErrorState>
            ) : (list.data ?? []).length === 0 ? (
              scope === "mine" ? (
                <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-10 text-center">
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-purple-600/10 text-purple-600">
                    <ClipboardList className="h-6 w-6" />
                  </span>
                  <p className="text-base font-semibold">No forms yet.</p>
                  <p className="max-w-sm text-sm text-[var(--text-muted)]">An RSVP takes about a minute.</p>
                  <button
                    type="button"
                    onClick={() => (isPhone ? setSheetOpen(true) : void create("rsvp", { template: "rsvp" }))}
                    className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[var(--accent-strong)] px-5 text-sm font-semibold text-white"
                  >
                    {creating === "rsvp" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {isPhone ? "Make a form" : "Make an RSVP"}
                  </button>
                </div>
              ) : (
                <p className="rounded-card border border-dashed border-[var(--border)] px-6 py-10 text-center text-sm text-[var(--text-muted)]">
                  Nobody has shared a form with you yet. When someone does, it shows here.
                </p>
              )
            ) : shown.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--text-muted)]">No forms match “{q.trim()}”.</p>
            ) : isPhone ? (
              <ul className="flex flex-col divide-y divide-[var(--border)] overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
                {shown.map((f) => (
                  <FormRow key={f.file_id} form={f} />
                ))}
              </ul>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((f) => (
                  <FormTile key={f.file_id} form={f} scope={scope} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      {isPhone && (
        <button
          type="button"
          aria-label="New form"
          onClick={() => setSheetOpen(true)}
          className="fixed bottom-[calc(20px+env(safe-area-inset-bottom,0px))] right-4 z-30 grid h-14 w-14 place-items-center rounded-full bg-[var(--accent-strong)] text-white shadow-[var(--shadow-lg)] transition active:scale-95"
        >
          <Plus className="h-6 w-6" />
        </button>
      )}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Start a new form">
        {starters}
      </Sheet>
    </>
  );
}

function closesLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return null;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `Closes ${d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: sameYear ? undefined : "numeric", hour: "numeric", minute: "2-digit" })}`;
}

function answersLabel(f: FormCard): string {
  const n = f.response_count;
  const base = n === 0 ? "No answers yet" : `${n} answer${n === 1 ? "" : "s"}`;
  const withNew = f.new_count > 0 && n > 0 ? `${base} · ${f.new_count} new` : base;
  // A quiz: "Quiz · 4 to mark · 12 answers".
  if (f.quiz) return `Quiz · ${f.to_mark ? `${f.to_mark} to mark · ` : ""}${withNew}`;
  return withNew;
}

function StateChip({ form }: { form: FormCard }) {
  const open = form.state === "open";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
        open ? "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400" : "bg-[var(--text-muted)]/15 text-[var(--text-muted)]"
      )}
    >
      {open ? "Open" : "Closed"}
    </span>
  );
}

function Banner({ form, className }: { form: Pick<FormCard, "accent" | "header_builtin" | "header_url">; className?: string }) {
  return (
    <div className={cn("pf-theme overflow-hidden", className)} data-scheme="app" style={themeVars(form.accent)} aria-hidden="true">
      {form.header_url ? (
        <img src={form.header_url} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : isBuiltinHeader(form.header_builtin) ? (
        <HeaderArt id={form.header_builtin} className="h-full w-full" />
      ) : (
        <div className="h-full w-full" style={{ background: "var(--pf-band)" }}>
          <div className="h-1.5 w-full" style={{ background: "var(--pf-accent)" }} />
        </div>
      )}
    </div>
  );
}

function FormTile({ form, scope }: { form: FormCard; scope: "mine" | "shared" }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const closes = closesLabel(form.close_at);
  const copy = async () => {
    try {
      const { file } = await filesApi.copyFileToMine(form.file_id);
      qc.invalidateQueries({ queryKey: ["forms-home"] });
      navigate(formBuilderPath(file.id));
    } catch (e) {
      toast.error(extractError(e));
    }
  };
  const trash = async () => {
    try {
      await filesApi.trashFile(form.file_id);
      qc.invalidateQueries({ queryKey: ["forms-home"] });
      invalidateFileQueries(qc);
      toast.info(`“${form.title}” moved to the trash`, {
        action: {
          label: "Undo",
          onClick: () =>
            void filesApi
              .restoreFile(form.file_id)
              .then(() => qc.invalidateQueries({ queryKey: ["forms-home"] }))
              .catch((e) => toast.error(extractError(e))),
        },
      });
    } catch (e) {
      toast.error(extractError(e));
    }
  };
  return (
    <li className="group relative flex flex-col overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] transition hover:shadow-[var(--shadow-md)]">
      <Banner form={form} className="h-20" />
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-start gap-2">
          <Link
            to={formBuilderPath(form.file_id)}
            className="min-w-0 flex-1 font-semibold leading-snug text-[var(--text)] after:absolute after:inset-0 after:content-[''] focus-visible:outline-none [overflow-wrap:anywhere]"
          >
            {form.title}
          </Link>
          {form.starred && <Star className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Starred" />}
        </div>
        <p className={cn("text-sm", form.new_count > 0 && form.response_count > 0 ? "font-medium text-[var(--text)]" : "text-[var(--text-muted)]")}>
          {answersLabel(form)}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1 text-xs text-[var(--text-muted)]">
          <StateChip form={form} />
          {closes && <span>{closes}</span>}
          {!closes && form.modified_at && <span>Edited {formatRelativeTime(form.modified_at)}</span>}
          {scope === "shared" && form.owner && <span>· {form.owner}</span>}
        </div>
      </div>
      <div className="absolute right-1.5 top-1.5 z-10 rounded-md bg-[var(--surface)]/90 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        <Menu label={`More for ${form.title}`} icon={<MoreVertical className="h-4 w-4" />}>
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); navigate(formBuilderPath(form.file_id)); }}>
                <ExternalLink className="h-4 w-4" /> Open
              </MenuItem>
              <MenuItem onClick={() => { close(); void copy(); }}>
                <Copy className="h-4 w-4" /> Make a copy
              </MenuItem>
              {scope === "mine" && (
                <MenuItem danger onClick={() => { close(); void trash(); }}>
                  <Trash2 className="h-4 w-4" /> Move to trash
                </MenuItem>
              )}
            </>
          )}
        </Menu>
      </div>
    </li>
  );
}

function FormRow({ form }: { form: FormCard }) {
  const closes = closesLabel(form.close_at);
  return (
    <li>
      <Link to={formBuilderPath(form.file_id)} className="flex min-h-[64px] items-center gap-3 px-3 py-2 hover:bg-[var(--hover)]">
        <Banner form={form} className="h-11 w-11 shrink-0 rounded-lg" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-[var(--text)]">{form.title}</span>
          <span className={cn("truncate text-xs", form.new_count > 0 && form.response_count > 0 ? "font-medium text-[var(--text)]" : "text-[var(--text-muted)]")}>
            {answersLabel(form)}
            {closes ? ` · ${closes}` : ""}
          </span>
        </span>
        <StateChip form={form} />
      </Link>
    </li>
  );
}

function StartStrip({
  templates,
  mine,
  creating,
  onCreate,
  vertical,
}: {
  templates: FormTemplateInfo[];
  mine: { id: string; title: string }[];
  creating: string | null;
  onCreate: (key: string, payload: { template?: string; template_id?: string }) => void;
  vertical: boolean;
}) {
  const tile = (key: string, title: string, sub: string, accent: string, onClick: () => void, blank = false) => (
    <li key={key} className={vertical ? "" : "w-40 shrink-0"}>
      <button
        type="button"
        onClick={onClick}
        disabled={!!creating}
        className={cn(
          "flex w-full overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] text-left transition hover:border-[var(--accent)]/60 hover:shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-70",
          vertical ? "min-h-[60px] items-center gap-3 p-2" : "h-full flex-col"
        )}
      >
        <span
          className={cn("pf-theme grid place-items-center", vertical ? "h-11 w-11 shrink-0 rounded-lg" : "h-16 w-full")}
          data-scheme="app"
          style={themeVars(accent)}
          aria-hidden="true"
        >
          {creating === key ? (
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--pf-accent)" }} />
          ) : blank ? (
            <Plus className="h-6 w-6" style={{ color: "var(--pf-accent)" }} />
          ) : (
            <ClipboardList className="h-5 w-5" style={{ color: "var(--pf-accent)" }} />
          )}
        </span>
        <span className={cn("flex min-w-0 flex-col", !vertical && "p-2.5")}>
          <span className="truncate text-sm font-medium text-[var(--text)]">{title}</span>
          <span className={cn("text-xs text-[var(--text-muted)]", vertical ? "truncate" : "line-clamp-2")}>{sub}</span>
        </span>
      </button>
    </li>
  );
  return (
    <ul className={cn(vertical ? "flex flex-col gap-2" : "-mx-1 flex gap-2 overflow-x-auto px-1 pb-2")} aria-label="Templates">
      {tile("blank", "Blank form", "Start from nothing", "terracotta", () => onCreate("blank", {}), true)}
      {templates.map((t) =>
        tile(t.key, t.title, t.description, t.accent, () => onCreate(t.key, { template: t.key }))
      )}
      {mine.map((t) => tile(`mine-${t.id}`, t.title, "Your template", "slate", () => onCreate(`mine-${t.id}`, { template_id: t.id })))}
    </ul>
  );
}
