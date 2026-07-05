import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AtSign } from "lucide-react";

import { useWorkspace } from "@/hooks/useWorkspaces";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { cn } from "@/utils/cn";

/**
 * A comment textarea that understands ``@``.
 *
 * Typing ``@`` (at start or after whitespace) opens a member picker fed
 * from the workspace's owner + collaborators; picking inserts the
 * ``@username`` token the backend mention parser resolves. Keyboard
 * (↑/↓/Enter/Tab/Esc) is handled before the caller's own onKeyDown so
 * ⌘+Enter-to-post keeps working. Deliberately plain-text — the token
 * IS the format, so nothing new to render or sanitise downstream.
 */
interface Member {
  user_id: string;
  username: string;
  avatar_url?: string | null;
  avatar_color?: string | null;
}

// Same charset as the backend's _MENTION_RE, anchored to the caret.
const TRIGGER_RE = /(?:^|\s)@([A-Za-z0-9_.\-]{0,30})$/;

export const MentionTextarea = forwardRef<
  HTMLTextAreaElement | null,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    workspaceId: string;
    value: string;
    onValueChange: (next: string) => void;
  }
>(function MentionTextarea(
  { workspaceId, value, onValueChange, onKeyDown, className, ...rest },
  ref
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement);
  const { data: workspace } = useWorkspace(workspaceId);
  const [pick, setPick] = useState<{ query: string; start: number } | null>(
    null
  );
  const [highlighted, setHighlighted] = useState(0);

  const members = useMemo<Member[]>(() => {
    const out: Member[] = [];
    if (workspace?.owner) out.push(workspace.owner);
    for (const c of workspace?.collaborators ?? []) out.push(c);
    return out;
  }, [workspace]);

  const candidates = useMemo(() => {
    if (!pick) return [];
    const q = pick.query.toLowerCase();
    return members
      .filter((m) => !q || m.username.toLowerCase().includes(q))
      .slice(0, 6);
  }, [members, pick]);

  const refreshTrigger = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = TRIGGER_RE.exec(before);
    if (!m) {
      setPick(null);
      return;
    }
    setPick({ query: m[1] ?? "", start: before.lastIndexOf("@") });
    setHighlighted(0);
  };

  const insert = (member: Member) => {
    const el = innerRef.current;
    if (!el || !pick) return;
    const caret = el.selectionStart ?? value.length;
    const next =
      value.slice(0, pick.start) + `@${member.username} ` + value.slice(caret);
    onValueChange(next);
    setPick(null);
    // Restore focus + caret after React applies the new value.
    requestAnimationFrame(() => {
      const pos = pick.start + member.username.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pick && candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted(
          (h) => (h - 1 + candidates.length) % candidates.length
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insert(candidates[highlighted]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPick(null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div className="relative min-w-0 flex-1">
      {pick && candidates.length > 0 && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-64 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            <AtSign className="h-3 w-3" />
            Mention a member
          </div>
          {candidates.map((m, i) => (
            <button
              key={m.user_id}
              type="button"
              // Keep the textarea focused so blur handlers don't fire.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(m)}
              onMouseEnter={() => setHighlighted(i)}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs",
                i === highlighted
                  ? "bg-[var(--accent)]/10 text-[var(--text)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--hover)]"
              )}
            >
              <UserAvatar
                name={m.username}
                userId={m.user_id}
                avatarUrl={m.avatar_url}
                color={m.avatar_color}
                size={18}
              />
              <span className="truncate font-medium text-[var(--text)]">
                {m.username}
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={innerRef}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          refreshTrigger(e.target.value, e.target.selectionStart ?? 0);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => setPick(null)}
        className={cn("w-full", className)}
        {...rest}
      />
    </div>
  );
});
