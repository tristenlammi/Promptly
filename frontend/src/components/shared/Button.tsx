import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cn } from "@/utils/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  loading?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-[var(--accent)] text-white hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
  secondary:
    "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
  ghost:
    "text-[var(--text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
  danger:
    "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-500",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  lg: "h-11 px-5 text-base gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    leftIcon,
    rightIcon,
    loading,
    className,
    children,
    disabled,
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center rounded-input font-medium transition",
        "focus:outline-none focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
