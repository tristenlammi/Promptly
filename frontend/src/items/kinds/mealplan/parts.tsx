import { Heart, Star, UtensilsCrossed, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Chip, TextInput, safeHref } from "@/items/ui";
import { cn } from "@/utils/cn";

import type { Recipe } from "./types";

/** A recipe's picture, or a warm initial tile when it has none. */
export function RecipeThumb({ recipe, size = 48, className }: { recipe: Pick<Recipe, "title" | "image_url">; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const src = safeHref(recipe.image_url);
  if (src && /^https?:/i.test(src) && !broken) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className={cn("shrink-0 rounded-xl object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const letter = recipe.title.trim()[0]?.toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_16%,transparent)] font-semibold text-[var(--item-accent)]",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {letter || <UtensilsCrossed className="h-1/2 w-1/2" />}
    </span>
  );
}

/** 1–5 stars; tap the current rating again to clear it. */
export function Stars({ value, onChange, size = "md" }: { value: number; onChange?: (v: number) => void; size?: "sm" | "md" | "lg" }) {
  const px = size === "sm" ? "h-3.5 w-3.5" : size === "lg" ? "h-8 w-8" : "h-5 w-5";
  return (
    <div className="flex items-center gap-0.5" role={onChange ? "radiogroup" : undefined} aria-label={`Rating: ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => {
        const on = n <= value;
        const icon = <Star className={cn(px, on ? "fill-[var(--item-accent)] text-[var(--item-accent)]" : "text-[var(--text-muted)] opacity-50")} />;
        return onChange ? (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={n === value}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            onClick={() => onChange(n === value ? 0 : n)}
            className={cn("flex items-center justify-center rounded-md", size === "lg" ? "h-12 w-12" : "h-9 w-9")}
          >
            {icon}
          </button>
        ) : (
          <span key={n}>{icon}</span>
        );
      })}
    </div>
  );
}

export function FavButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={on ? "Remove from favourites" : "Add to favourites"}
      aria-pressed={on}
      onClick={onClick}
      className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]"
    >
      <Heart className={cn("h-5 w-5", on && "fill-[var(--danger)] text-[var(--danger)]")} />
    </button>
  );
}

/** Pick from suggestions or type your own: diets, allergies, equipment… */
export function ChipPicker({
  value,
  onChange,
  options,
  placeholder = "Add your own…",
  tone = "accent",
  disabled,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  options: string[];
  placeholder?: string;
  tone?: "accent" | "danger";
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const has = (o: string) => value.some((v) => v.toLowerCase() === o.toLowerCase());
  const toggle = (o: string) => onChange(has(o) ? value.filter((v) => v.toLowerCase() !== o.toLowerCase()) : [...value, o]);
  const extra = value.filter((v) => !options.some((o) => o.toLowerCase() === v.toLowerCase()));
  const add = () => {
    const t = text.trim();
    if (t && !has(t)) onChange([...value, t]);
    setText("");
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {[...options, ...extra].map((o) => (
          <Chip
            key={o}
            active={has(o)}
            onClick={disabled ? undefined : () => toggle(o)}
            className={cn(
              "h-9 capitalize md:h-8",
              tone === "danger" && has(o) && "border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]",
            )}
            icon={extra.includes(o) && has(o) ? <X className="h-3 w-3" /> : undefined}
          >
            {o}
          </Chip>
        ))}
      </div>
      {!disabled && (
        <TextInput
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder={placeholder}
          aria-label={placeholder}
        />
      )}
    </div>
  );
}

export function Callout({ tone = "info", icon, children }: { tone?: "info" | "warning" | "danger"; icon?: ReactNode; children: ReactNode }) {
  const color = tone === "danger" ? "var(--danger)" : tone === "warning" ? "var(--warning)" : "var(--item-accent)";
  return (
    <div
      className="flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm text-[var(--text)]"
      style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 9%, transparent)` }}
    >
      {icon && <span className="mt-0.5 shrink-0" style={{ color }}>{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A round check for lists (grocery, cook-mode ingredients). */
export function CheckDot({ on, big }: { on: boolean; big?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border-2 transition",
        big ? "h-8 w-8" : "h-6 w-6",
        on ? "border-[var(--item-accent)] bg-[var(--item-accent-fill)] text-white" : "border-[var(--border)] bg-[var(--surface)]",
      )}
    >
      {on && (
        <svg viewBox="0 0 16 16" className={big ? "h-5 w-5" : "h-3.5 w-3.5"} fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}
