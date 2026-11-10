import { Minus, Plus } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { EmptyState as SharedEmptyState } from "@/components/shared/EmptyState";
import { Tooltip } from "@/components/shared/Tooltip";
import { cn } from "@/utils/cn";

/*
 * The item UI kit. Every item builds from these so the eleven apps feel
 * like one product: warm surfaces, the item's own accent (``--item-accent``,
 * set by the shell from the spec's colour), 44px touch targets on a phone,
 * tabular numbers for anything measured.
 */

export function Card({
  children,
  className,
  onClick,
  as: As = "div",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  as?: "div" | "section" | "article" | "li";
  padded?: boolean;
}) {
  const clickable = !!onClick;
  return (
    <As
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      className={cn(
        "rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]",
        padded && "p-4",
        clickable && "cursor-pointer transition hover:border-[var(--item-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
        className,
      )}
    >
      {children}
    </As>
  );
}

export function Section({
  title,
  action,
  children,
  className,
  hint,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  hint?: ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold text-[var(--text)]">{title}</h2>}
            {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A labelled number: ``<Stat label="Volume" value="12,450" unit="kg" delta="+8%" />`` */
export function Stat({
  label,
  value,
  unit,
  delta,
  tone = "neutral",
  icon: Icon,
  className,
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  delta?: ReactNode;
  tone?: "neutral" | "good" | "bad" | "accent";
  icon?: ComponentType<{ className?: string }>;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <Card className={cn("flex flex-col gap-1", className)} onClick={onClick}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span
          className={cn(
            "text-2xl font-semibold tabular-nums tracking-tight",
            tone === "accent" ? "text-[var(--item-accent)]" : "text-[var(--text)]",
          )}
        >
          {value}
        </span>
        {unit && <span className="text-sm text-[var(--text-muted)]">{unit}</span>}
      </div>
      {delta && (
        <span
          className={cn(
            "text-xs font-medium tabular-nums",
            tone === "good" && "text-[var(--success)]",
            tone === "bad" && "text-[var(--danger)]",
            (tone === "neutral" || tone === "accent") && "text-[var(--text-muted)]",
          )}
        >
          {delta}
        </span>
      )}
    </Card>
  );
}

/** The width an element actually gets (the AI panel takes a column on
 *  desktop, so screen breakpoints overstate it). Attach the returned ref. */
export function useWidth<T extends HTMLElement = HTMLDivElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    ro.current = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.current.observe(el);
  }, []);
  return [ref, width];
}

export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  const [ref, width] = useWidth();
  return <div ref={ref} className={cn("grid gap-3", width >= 600 ? "grid-cols-4" : "grid-cols-2", className)}>{children}</div>;
}

/** One row in a list: leading visual, title / subtitle, trailing bits.
 *  ``trailing`` is display-only (it sits inside the row's button when the
 *  row is clickable); put buttons / checkboxes in ``action``, which renders
 *  beside the row's button, never inside it. */
export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  action,
  onClick,
  className,
  selected,
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  action?: ReactNode;
  onClick?: () => void;
  className?: string;
  selected?: boolean;
}) {
  const body = (
    <>
      {leading && <div className="flex shrink-0 items-center">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-[var(--text)]">{title}</div>
        {subtitle && <div className="truncate text-xs text-[var(--text-muted)]">{subtitle}</div>}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-2 text-sm text-[var(--text-muted)]">{trailing}</div>}
    </>
  );
  const cls = cn(
    "flex min-h-[52px] w-full items-center gap-3 px-3 py-2 text-left",
    selected && "bg-[var(--hover)]",
    className,
  );
  const row = onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(cls, action && "min-w-0 flex-1", "transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]")}
    >
      {body}
    </button>
  ) : (
    <div className={cn(cls, action && "min-w-0 flex-1")}>{body}</div>
  );
  if (!action) return row;
  return (
    <div className={cn("flex items-center", selected && "bg-[var(--hover)]")}>
      {row}
      <div className="flex shrink-0 items-center gap-1 pr-2">{action}</div>
    </div>
  );
}

/** A rounded group of rows with hairline dividers. */
export function List({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export const ItemButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "ghost" | "danger";
    size?: "sm" | "md" | "lg";
    icon?: ReactNode;
    block?: boolean;
  }
>(function ItemButton({ variant = "secondary", size = "md", icon, block, className, children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cn(
        "inline-flex select-none items-center justify-center gap-2 rounded-xl font-medium transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] focus-visible:ring-offset-1",
        size === "sm" && "h-8 px-3 text-xs",
        size === "md" && "h-11 px-4 text-sm md:h-10",
        size === "lg" && "h-12 px-5 text-base",
        variant === "primary" && "bg-[var(--item-accent)] text-white shadow-[var(--shadow-sm)] hover:brightness-95 active:brightness-90",
        variant === "secondary" && "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)]",
        variant === "ghost" && "text-[var(--text)] hover:bg-[var(--hover)]",
        variant === "danger" && "bg-[var(--danger)] text-white hover:brightness-95",
        block && "w-full",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  icon: Icon,
  onClick,
  className,
  active,
  disabled,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick?: () => void;
  className?: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
          active && "bg-[var(--hover)] text-[var(--item-accent)]",
          className,
        )}
      >
        <Icon className="h-[18px] w-[18px]" />
      </button>
    </Tooltip>
  );
}

/** Segmented control (2–5 options). */
export function Segmented<V extends string>({
  value,
  onChange,
  options,
  className,
  size = "md",
}: {
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: ReactNode }[];
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" className={cn("inline-flex rounded-xl bg-[var(--surface-2)] p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 whitespace-nowrap rounded-lg px-3 font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
            size === "sm" ? "h-7 text-xs" : "h-9 text-sm",
            o.value === value
              ? "bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]"
              : "text-[var(--text-muted)] hover:text-[var(--text)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({
  children,
  active,
  onClick,
  className,
  icon,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
  icon?: ReactNode;
}) {
  const cls = cn(
    "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition",
    active
      ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--text)]"
      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]",
    onClick && "hover:text-[var(--text)]",
    className,
  );
  return onClick ? (
    <button type="button" aria-pressed={active} onClick={onClick} className={cls}>
      {icon}
      {children}
    </button>
  ) : (
    <span className={cls}>
      {icon}
      {children}
    </span>
  );
}

/** − value + with big targets; ``step`` and bounds; tap the value to type. */
export function Stepper({
  value,
  onChange,
  step = 1,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  unit,
  label,
  decimals,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  label?: string;
  decimals?: number;
  className?: string;
}) {
  const places = decimals ?? (String(step).split(".")[1]?.length || 0);
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Number(v.toFixed(places)))));
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>}
      <div className="flex items-center rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <button
          type="button"
          aria-label={`Less${label ? ` ${label}` : ""}`}
          onClick={() => set(value - step)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-l-xl text-[var(--text-muted)] hover:bg-[var(--hover)] active:bg-[var(--hover-strong)]"
        >
          <Minus className="h-4 w-4" />
        </button>
        <input
          inputMode="decimal"
          aria-label={label}
          value={Number.isFinite(value) ? String(value) : ""}
          onChange={(e) => {
            const n = parseFloat(e.target.value.replace(",", "."));
            if (Number.isFinite(n)) set(n);
            else if (e.target.value === "") onChange(min);
          }}
          onFocus={(e) => e.currentTarget.select()}
          className="h-11 w-full min-w-0 bg-transparent text-center text-base font-semibold tabular-nums text-[var(--text)] outline-none"
        />
        {unit && <span className="pr-1 text-xs text-[var(--text-muted)]">{unit}</span>}
        <button
          type="button"
          aria-label={`More${label ? ` ${label}` : ""}`}
          onClick={() => set(value + step)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-r-xl text-[var(--text-muted)] hover:bg-[var(--hover)] active:bg-[var(--hover-strong)]"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-[var(--text-muted)]">{hint}</span>}
    </label>
  );
}

const inputCls =
  "h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-base text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--item-accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--item-accent)_25%,transparent)] md:h-10 md:text-sm";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} {...rest} className={cn(inputCls, className)} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} {...rest} className={cn(inputCls, "h-auto min-h-[88px] py-2.5 leading-relaxed", className)} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(inputCls, "appearance-auto pr-8", className)}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition",
        checked ? "bg-[var(--item-accent)]" : "bg-[var(--surface-2)]",
      )}
    >
      <span className={cn("inline-block h-5 w-5 rounded-full bg-white shadow transition", checked ? "translate-x-6" : "translate-x-1")} />
    </button>
  );
}

/** The item kit's empty state. Draws the one shared style
 *  (``@/components/shared/EmptyState``); kept here for its item-flavoured
 *  props (an icon component, ``text``). */
export function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  className,
  compact,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <SharedEmptyState
      icon={Icon ? <Icon className={compact ? "h-4 w-4" : "h-5 w-5"} /> : undefined}
      title={title}
      description={text}
      action={action}
      compact={compact}
      className={className}
    />
  );
}

/** A ring for "3 of 5 done": ``value`` 0..1. */
export function ProgressRing({
  value,
  size = 56,
  stroke = 6,
  children,
  color,
}: {
  value: number;
  size?: number;
  stroke?: number;
  children?: ReactNode;
  color?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color ?? "var(--item-accent)"}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          style={{ transition: "stroke-dashoffset 400ms ease" }}
        />
      </svg>
      {children && <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums">{children}</div>}
    </div>
  );
}

export function ProgressBar({ value, className, color }: { value: number; className?: string; color?: string }) {
  const v = Math.max(0, Math.min(1, value || 0));
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]", className)}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${v * 100}%`, background: color ?? "var(--item-accent)" }} />
    </div>
  );
}

const AVATAR_TINTS = ["#E2725B", "#4F8A8B", "#7B6CD9", "#C08B2C", "#3E8E5A", "#C2557A", "#3B7DD8", "#8A6F5A"];

export function Avatar({ name, src, size = 36, className }: { name: string; src?: string | null; size?: number; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  if (src) return <img src={src} alt="" className={cn("shrink-0 rounded-full object-cover", className)} style={{ width: size, height: size }} />;
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white", className)}
      style={{ width: size, height: size, background: AVATAR_TINTS[h % AVATAR_TINTS.length], fontSize: size * 0.38 }}
    >
      {initials || "?"}
    </span>
  );
}

/** A floating action button for a phone — sits above the tab bar. */
export function Fab({ label, icon: Icon, onClick }: { label: string; icon: ComponentType<{ className?: string }>; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="fixed bottom-[calc(76px+env(safe-area-inset-bottom,0px))] right-4 z-30 flex h-14 items-center gap-2 rounded-2xl bg-[var(--item-accent)] px-5 text-sm font-semibold text-white shadow-[var(--shadow-lg)] transition active:scale-95 md:hidden"
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}

/** A horizontal row that scrolls on a phone (chips, day strips). */
export function ScrollRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:px-0", className)}>{children}</div>;
}

/** The page body of a tab: padded, centred, room for the phone tab bar. */
export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return (
    <div className={cn("mx-auto flex w-full flex-col gap-5 px-4 py-4 md:px-6 md:py-6", wide ? "max-w-6xl" : "max-w-3xl", className)}>
      {children}
    </div>
  );
}

/** Focus an element once it mounts (sheets, inline editors). */
export function useAutoFocus<T extends HTMLElement>(when = true) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (when) window.setTimeout(() => ref.current?.focus(), 60);
  }, [when]);
  return ref;
}
