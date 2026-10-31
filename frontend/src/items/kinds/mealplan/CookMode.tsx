import { ChevronLeft, ChevronRight, ListChecks, Pause, Play, Timer, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ItemButton, ProgressBar, fmtDuration } from "@/items/ui";
import { cn } from "@/utils/cn";

import { chime, detectTimers, useWakeLock } from "./helpers";
import { CheckDot, Stars } from "./parts";
import type { Recipe } from "./types";
import { convertTemps, ingredientText, scaleIngredient, type UnitSystem } from "./units";

interface RunningTimer {
  id: string;
  label: string;
  total: number;
  endsAt: number | null; // ms; null while paused
  left: number; // seconds left when paused
  done: boolean;
}

/* Timers outlive cook mode: closing it (to check the plan, answer a message)
 * and coming back finds them still running. They're kept per recipe in this
 * module and in sessionStorage (a reload of the tab keeps them too); end
 * times are absolute, so nothing drifts while cook mode is closed. */
const STORE_KEY = "promptly.mealplan.cookTimers";
const timerStore = new Map<string, RunningTimer[]>();
let storeLoaded = false;

function loadTimers(recipeId: string): RunningTimer[] {
  if (!storeLoaded) {
    storeLoaded = true;
    try {
      const raw = sessionStorage.getItem(STORE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, RunningTimer[]>) : {};
      for (const [k, v] of Object.entries(parsed)) if (Array.isArray(v)) timerStore.set(k, v);
    } catch {
      /* storage blocked — module memory only */
    }
  }
  return timerStore.get(recipeId) ?? [];
}

function saveTimers(recipeId: string, list: RunningTimer[]) {
  if (list.length) timerStore.set(recipeId, list);
  else timerStore.delete(recipeId);
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(timerStore)));
  } catch {
    /* storage blocked */
  }
}

/** Keys typed into a control belong to it: Space presses a focused button,
 *  arrows move a caret. */
function ownsKey(target: EventTarget | null, key: string): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return true;
  return key === " " && !!el.closest("button, a[href], [role='button'], [role='radio'], [role='checkbox'], summary");
}

/**
 * Full-screen, step by step: big text, the ingredient checklist, timers
 * found in the steps ("bake 25 minutes" → tap to start), the screen kept
 * awake. Arrow keys / Space / swipes move between steps (not while a button
 * or field has focus). Timers keep running if cook mode is closed.
 */
export function CookMode({
  recipe,
  factor = 1,
  system = "keep",
  units,
  keepAwake = true,
  onClose,
  onFinish,
}: {
  recipe: Recipe;
  factor?: number;
  system?: UnitSystem;
  units: "metric" | "imperial";
  keepAwake?: boolean;
  onClose: () => void;
  onFinish?: (rating: number) => void;
}) {
  const steps = recipe.steps.length ? recipe.steps : ["This recipe has no steps yet — follow the ingredients and your instincts."];
  const [step, setStep] = useState(0);
  const [finished, setFinished] = useState(false);
  const [rating, setRating] = useState(recipe.rating || 0);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [showIngredients, setShowIngredients] = useState(false);
  const [timers, setTimers] = useState<RunningTimer[]>(() => loadTimers(recipe.id));
  const [, tick] = useState(0);
  const [announce, setAnnounce] = useState("");
  const startX = useRef<number | null>(null);
  useWakeLock(keepAwake);
  useEffect(() => saveTimers(recipe.id, timers), [recipe.id, timers]);

  const ingredients = useMemo(() => recipe.ingredients.map((i) => scaleIngredient(i, factor, system)), [recipe.ingredients, factor, system]);
  const text = convertTemps(steps[step], units);
  const found = useMemo(() => detectTimers(steps[step]), [steps, step]);
  const usedHere = useMemo(() => {
    const low = steps[step].toLowerCase();
    return ingredients.filter((i) => {
      const words = i.item.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      return words.some((w) => low.includes(w.replace(/(es|s)$/, "")));
    });
  }, [ingredients, steps, step]);

  const go = useCallback(
    (d: number) => {
      setStep((s) => {
        const n = s + d;
        if (n >= steps.length) {
          setFinished(true);
          return s;
        }
        return Math.max(0, n);
      });
    },
    [steps.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || ownsKey(e.target, e.key)) return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [go, onClose]);

  // Timers tick once a second while any runs.
  const running = timers.some((t) => t.endsAt && !t.done);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      const now = Date.now();
      setTimers((list) =>
        list.map((x) => {
          if (x.endsAt && !x.done && x.endsAt <= now) {
            chime();
            setAnnounce(`${x.label} timer done`);
            return { ...x, done: true, endsAt: null, left: 0 };
          }
          return x;
        }),
      );
      tick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const start = (label: string, seconds: number) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setTimers((list) => [...list, { id, label, total: seconds, endsAt: Date.now() + seconds * 1000, left: seconds, done: false }]);
    setAnnounce(`Timer started: ${label}`);
  };
  const leftOf = (t: RunningTimer) => (t.endsAt ? Math.max(0, Math.round((t.endsAt - Date.now()) / 1000)) : t.left);

  const ingredientList = (
    <ul className="flex flex-col">
      {ingredients.map((i, n) => {
        const on = checked.has(i.id);
        const header = i.group && i.group !== ingredients[n - 1]?.group;
        return (
          <li key={i.id}>
            {header && <p className="px-1 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{i.group}</p>}
            <button
              type="button"
              aria-pressed={on}
              onClick={() =>
                setChecked((s) => {
                  const next = new Set(s);
                  if (next.has(i.id)) next.delete(i.id);
                  else next.add(i.id);
                  return next;
                })
              }
              className="flex min-h-[52px] w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-[var(--hover)]"
            >
              <CheckDot on={on} />
              <span className={cn("text-base leading-snug text-[var(--text)]", on && "text-[var(--text-muted)] line-through")}>{ingredientText(i)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-[var(--bg)] pt-safe"
      role="dialog"
      aria-modal="true"
      aria-label={`Cooking ${recipe.title}`}
      onPointerDown={(e) => {
        if (e.pointerType === "touch") startX.current = e.clientX;
      }}
      onPointerUp={(e) => {
        if (startX.current === null) return;
        const dx = e.clientX - startX.current;
        startX.current = null;
        if (Math.abs(dx) > 70 && !showIngredients) go(dx < 0 ? 1 : -1);
      }}
    >
      <div className="sr-only" aria-live="assertive">
        {announce}
      </div>
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-[var(--border)] pl-2 pr-3 md:px-4">
        <button type="button" aria-label="Close cook mode" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <X className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--text)]">{recipe.title}</p>
          <p className="text-xs tabular-nums text-[var(--text-muted)]">{finished ? "Done" : `Step ${step + 1} of ${steps.length}`}</p>
        </div>
        <button
          type="button"
          onClick={() => setShowIngredients((s) => !s)}
          aria-pressed={showIngredients}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium md:hidden",
            showIngredients ? "border-[var(--item-accent)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-muted)]",
          )}
        >
          <ListChecks className="h-4 w-4" /> Ingredients
        </button>
      </header>
      <ProgressBar value={finished ? 1 : (step + 1) / steps.length} className="h-1 rounded-none" />

      {timers.length > 0 && (
        <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-[var(--border)] px-3 py-2 [scrollbar-width:none]">
          {timers.map((t) => {
            const left = leftOf(t);
            return (
              <div
                key={t.id}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-xl border px-3 py-1.5",
                  t.done ? "animate-pulse border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]" : "border-[var(--border)] bg-[var(--surface)]",
                )}
              >
                <Timer className="h-4 w-4 text-[var(--item-accent)]" />
                <span className="text-xs text-[var(--text-muted)]">{t.label}</span>
                <span className="text-lg font-semibold tabular-nums text-[var(--text)]" aria-label={`${t.label}: ${t.done ? "done" : fmtDuration(left) + " left"}`}>
                  {t.done ? "Done!" : fmtDuration(left)}
                </span>
                {!t.done && (
                  <button
                    type="button"
                    aria-label={t.endsAt ? `Pause ${t.label}` : `Resume ${t.label}`}
                    onClick={() =>
                      setTimers((list) =>
                        list.map((x) =>
                          x.id !== t.id ? x : x.endsAt ? { ...x, endsAt: null, left: leftOf(x) } : { ...x, endsAt: Date.now() + x.left * 1000 },
                        ),
                      )
                    }
                    className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--hover)]"
                  >
                    {t.endsAt ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Dismiss ${t.label} timer`}
                  onClick={() => setTimers((list) => list.filter((x) => x.id !== t.id))}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[340px] shrink-0 overflow-y-auto border-r border-[var(--border)] p-4 md:block lg:w-[400px]">
          <h2 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Ingredients</h2>
          {ingredientList}
        </aside>
        <main className="relative min-w-0 flex-1 overflow-y-auto">
          {showIngredients ? (
            <div className="p-4 md:hidden">{ingredientList}</div>
          ) : finished ? (
            <div className="mx-auto flex max-w-xl flex-col items-center gap-5 px-6 py-12 text-center">
              <p className="text-3xl font-semibold text-[var(--text)]">Enjoy your meal!</p>
              <p className="text-base text-[var(--text-muted)]">How did it turn out?</p>
              <Stars value={rating} onChange={setRating} size="lg" />
              <div className="flex w-full flex-col gap-2 sm:flex-row">
                {onFinish && (
                  <ItemButton variant="primary" size="lg" block onClick={() => onFinish(rating)}>
                    Mark as cooked
                  </ItemButton>
                )}
                <ItemButton size="lg" block onClick={() => setFinished(false)}>
                  Back to the steps
                </ItemButton>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-8 md:px-10 md:py-12">
              <p className="text-sm font-semibold uppercase tracking-wide text-[var(--item-accent)]">Step {step + 1}</p>
              <p className="text-2xl font-medium leading-relaxed text-[var(--text)] md:text-3xl md:leading-relaxed">{text}</p>
              {found.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {found.map((t) => (
                    <ItemButton key={t.label} variant="secondary" size="lg" icon={<Timer className="h-5 w-5 text-[var(--item-accent)]" />} onClick={() => start(t.label, t.seconds)}>
                      Start {t.label}
                    </ItemButton>
                  ))}
                </div>
              )}
              {usedHere.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">In this step</p>
                  <ul className="flex flex-wrap gap-2">
                    {usedHere.map((i) => (
                      <li key={i.id} className="rounded-xl bg-[var(--surface-2)] px-3 py-1.5 text-sm text-[var(--text)]">
                        {ingredientText({ ...i, note: "" })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      {!finished && !showIngredients && (
        <footer className="flex shrink-0 gap-3 border-t border-[var(--border)] px-4 py-3 pb-safe-toolbar">
          <ItemButton size="lg" className="h-14 flex-1" disabled={step === 0} onClick={() => go(-1)} icon={<ChevronLeft className="h-5 w-5" />}>
            Back
          </ItemButton>
          <ItemButton variant="primary" size="lg" className="h-14 flex-[2]" onClick={() => go(1)}>
            {step === steps.length - 1 ? "Finish" : "Next step"} <ChevronRight className="h-5 w-5" />
          </ItemButton>
        </footer>
      )}
    </div>,
    document.body,
  );
}
