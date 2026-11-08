import { Check, Plus } from "lucide-react";
import { useRef } from "react";
import { Link, useNavigate } from "react-router-dom";

import type { PorchGroup } from "@/api/porch";
import { cn } from "@/utils/cn";

import { useGroupActions } from "../actions";

const chip =
  "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)]";
const on = "border-[var(--item-accent)] bg-[var(--item-accent)] text-white";
const off = "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]";

/**
 * The feed's groups, as chips you tick and untick (saved on your account at
 * once, so it's the same on every device). "All" ticks or unticks the lot.
 * Hold a chip (or right-click it) to open the group.
 */
export function GroupChips({ groups, className }: { groups: PorchGroup[]; className?: string }) {
  const { setTicks } = useGroupActions();
  const navigate = useNavigate();
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; fired: boolean }>({ timer: null, fired: false });
  const allOn = groups.length > 0 && groups.every((g) => g.in_feed);

  const press = (g: PorchGroup) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      hold.current.fired = false;
      hold.current.timer = setTimeout(() => {
        hold.current.fired = true;
        navigate(`/porch/g/${g.id}`);
      }, 550);
    },
    onPointerUp: () => {
      if (hold.current.timer) clearTimeout(hold.current.timer);
    },
    onPointerLeave: () => {
      if (hold.current.timer) clearTimeout(hold.current.timer);
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      navigate(`/porch/g/${g.id}`);
    },
    onClick: () => {
      if (hold.current.fired) {
        hold.current.fired = false;
        return;
      }
      setTicks({ [g.id]: !g.in_feed });
    },
  });

  return (
    <div
      role="group"
      aria-label="Groups in your feed"
      className={cn("flex gap-2 overflow-x-auto px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:px-0", className)}
    >
      <button
        type="button"
        aria-pressed={allOn}
        onClick={() => setTicks(Object.fromEntries(groups.map((g) => [g.id, !allOn])))}
        className={cn(chip, allOn ? on : off)}
      >
        {allOn && <Check className="h-4 w-4" aria-hidden />}
        All
      </button>
      {groups.map((g) => (
        <button
          key={g.id}
          type="button"
          aria-pressed={!!g.in_feed}
          title={`${g.in_feed ? "In your feed" : "Not in your feed"}. Hold or right-click to open ${g.name}.`}
          className={cn(chip, g.in_feed ? on : off, "select-none")}
          {...press(g)}
        >
          {g.in_feed && <Check className="h-4 w-4" aria-hidden />}
          {g.emoji && <span aria-hidden>{g.emoji}</span>}
          {g.name}
        </button>
      ))}
      <Link to="/porch/groups#find" className={cn(chip, off, "border-dashed")}>
        <Plus className="h-4 w-4" aria-hidden /> Find groups
      </Link>
    </div>
  );
}
