import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Play, Plus, Workflow } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import type { Home } from "@/api/home";
import { homeAutomationsApi, type HomeAutomation } from "@/api/homeAutomations";
import { useIsMobile } from "@/hooks/useIsMobile";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { runWords } from "./steps";

/**
 * A home's automations, on the Home page: several things done at once when
 * someone says a phrase ("movie time"), at a time, or when a device changes.
 * Everyone in the home can run one from here. Whoever looks after the home
 * makes and changes them, in the flow editor (a bigger screen).
 */

export const AUTOMATIONS_KEY = (homeId: string) => ["home", "automations", homeId];

const quiet =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-xs font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const strong =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-[var(--accent-strong)] px-3 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";

export function AutomationsSection({ home }: { home: Home }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const phone = useIsMobile();
  const key = AUTOMATIONS_KEY(home.id);
  const { data } = useQuery({ queryKey: key, queryFn: () => homeAutomationsApi.list(home.id), refetchInterval: 20_000 });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const again = () => void qc.invalidateQueries({ queryKey: key });

  const create = useMutation({
    mutationFn: () => homeAutomationsApi.create(home.id, name.trim()),
    onSuccess: (made) => {
      setNaming(false);
      setName("");
      again();
      navigate(`/home/automations/${home.id}/${made.id}`);
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't make it. Try again.")),
  });
  const run = useMutation({
    mutationFn: (a: HomeAutomation) => homeAutomationsApi.run(home.id, a.id),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.words);
      else toast.error(r.words);
      again();
    },
    onError: (e) => toast.error(apiErrorMessage(e, "That didn't run. Try again.")),
  });
  const turn = useMutation({
    mutationFn: (a: HomeAutomation) => homeAutomationsApi.save(home.id, a.id, { enabled: !a.enabled }),
    onSuccess: again,
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't change that.")),
  });

  if (!data) return null;
  const list = data.automations;
  // Nothing made yet: only whoever can make one is told about them.
  if (list.length === 0 && !data.can_edit) return null;

  return (
    <section aria-label="Automations" className="flex flex-col gap-2">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--text-muted)]">Automations</h2>
        {data.can_edit && !phone && !naming && (
          <button type="button" className={quiet} onClick={() => setNaming(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> New automation
          </button>
        )}
      </div>

      {naming && (
        <form
          className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <label htmlFor="new-automation-name" className="sr-only">Name</label>
          <input
            id="new-automation-name"
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="What's it called? e.g. Movie time"
            className="h-9 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <button type="submit" className={strong} disabled={!name.trim() || create.isPending}>Make it</button>
          <button type="button" className={quiet} onClick={() => setNaming(false)}>Cancel</button>
        </form>
      )}

      {list.length === 0 && !naming && (
        <div className="flex items-start gap-3 rounded-2xl border border-dashed border-[var(--border)] px-4 py-3">
          <Workflow className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-text,var(--accent))]" aria-hidden />
          <p className="min-w-0 text-sm text-[var(--text-muted)]">
            Make your home do several things at once: when you say a phrase like “movie time”, at a time of day, or when a device changes.
            {phone ? " Automations are made on a computer; you can run them from here." : ""}
          </p>
        </div>
      )}

      {list.length > 0 && (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {list.map((a) => {
            const last = runWords(a.last);
            const empty = a.steps === 0;
            return (
              <li key={a.id} className={cn("flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5", !a.enabled && "opacity-70")}>
                <button
                  type="button"
                  aria-label={`Run ${a.name}`}
                  title={empty ? "It has no steps yet" : `Run ${a.name}`}
                  disabled={empty || (run.isPending && run.variables?.id === a.id)}
                  onClick={() => run.mutate(a)}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white transition hover:opacity-90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1"
                >
                  <Play className="h-4 w-4" aria-hidden />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[var(--text)]">{a.name}</p>
                  <p className="truncate text-xs text-[var(--text-muted)]">
                    {empty ? "No steps yet" : !a.enabled ? "Switched off" : a.phrases.length > 0 ? `Say “${a.phrases[0]}”` : a.trigger.words}
                    {!empty && a.enabled && a.phrases.length > 0 && a.trigger.kind !== "asked" ? ` · ${a.trigger.words}` : ""}
                  </p>
                  <p className={cn("truncate text-xs", last.tone === "bad" ? "text-[var(--danger)]" : last.tone === "warn" ? "text-[var(--warning)]" : "text-[var(--text-muted)]")}>
                    {last.words}
                  </p>
                </div>
                {a.can_edit && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    {!empty && (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={a.enabled}
                        aria-label={`${a.name} is switched ${a.enabled ? "on" : "off"}`}
                        title={a.enabled ? "Switched on: tap to switch off" : "Switched off: tap to switch on"}
                        disabled={turn.isPending}
                        onClick={() => turn.mutate(a)}
                        className={cn("relative h-6 w-10 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1", a.enabled ? "bg-[var(--accent-strong)]" : "bg-[var(--border)]")}
                      >
                        <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", a.enabled ? "left-[18px]" : "left-0.5")} />
                      </button>
                    )}
                    {!phone && (
                      <Link
                        to={`/home/automations/${home.id}/${a.id}`}
                        aria-label={`Change ${a.name}`}
                        title="Change it"
                        className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Link>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
