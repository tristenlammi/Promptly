import { Mail, MessageSquare, Phone, Users, Sparkles, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

import type { ItemHandle } from "@/items/useItem";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

import { avatarColor, homeCountry, initials } from "./model";
import { useLinkedPerson } from "./photosLink";
import type { Contact, ContactsData, InteractionType } from "./types";

/* Contacts — small shared pieces: the initials avatar, the edit helper,
 * cross-tab hand-offs, the download helper. */

export type Handle = ItemHandle<ContactsData>;

/** Their photo — or, with none of their own, their face from Photos when
 *  they're linked to someone there (``linked={false}``: only their own,
 *  e.g. the edit form's photo picker) — else coloured initials. */
export function ContactAvatar({ contact, size = 40, className, linked = true }: { contact: Contact; size?: number; className?: string; linked?: boolean }) {
  const person = useLinkedPerson(contact.id);
  const src = contact.photo || (linked ? person?.face : null) || null;
  // A face link that's gone stale falls back to the initials.
  const [broken, setBroken] = useState<string | null>(null);
  if (src && src !== broken) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setBroken(src)}
        className={cn("inline-block shrink-0 select-none rounded-full object-cover", className)}
        style={{ width: size, height: size, background: avatarColor(contact) }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white", className)}
      style={{ width: size, height: size, background: avatarColor(contact), fontSize: Math.round(size * 0.38) }}
    >
      {initials(contact)}
    </span>
  );
}

/** Change one contact (stamps ``updated_at``). ``fn`` may run again on
 *  newer data: make ids / times before calling, and only set what changed. */
export function editContact(item: Handle, id: string, fn: (c: Contact, d: ContactsData) => void): void {
  const now = new Date().toISOString();
  item.update((d) => {
    const c = d.contacts.find((x) => x.id === id);
    if (!c) return;
    fn(c, d);
    c.updated_at = now;
  });
}

/** The country this person's national phone numbers are read in. */
export function useHomeCountry(item: Handle): string {
  const userSettings = useAuthStore((s) => s.user?.settings) as Record<string, unknown> | undefined;
  const pref = item.data.settings.phone_country;
  return useMemo(() => homeCountry({ phone_country: pref }, userSettings), [pref, userSettings]);
}

export const INTERACTION_META: Record<InteractionType, { label: string; verb: string; icon: LucideIcon }> = {
  call: { label: "Call", verb: "Called", icon: Phone },
  message: { label: "Message", verb: "Messaged", icon: MessageSquare },
  meeting: { label: "Met up", verb: "Met up", icon: Users },
  email: { label: "Email", verb: "Emailed", icon: Mail },
  other: { label: "Other", verb: "Caught up", icon: Sparkles },
};

export const REL_LABELS: Record<string, string> = {
  partner: "Partner",
  spouse: "Spouse",
  child: "Child",
  parent: "Parent",
  sibling: "Sibling",
  friend: "Friend",
  colleague: "Colleague",
  manager: "Manager",
  report: "Reports to them",
  relative: "Relative",
  other: "Other",
};

// --------------------------------------------------- cross-tab hand-offs

export type PeopleFilter =
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "due" }
  | { kind: "group"; id: string }
  | { kind: "tag"; tag: string };

let pendingFilter: PeopleFilter | null = null;

/** Open People with this filter the next time it mounts. */
export function setPendingFilter(f: PeopleFilter): void {
  pendingFilter = f;
}

export function takePendingFilter(): PeopleFilter | null {
  const f = pendingFilter;
  pendingFilter = null;
  return f;
}

/* The header's "Add contact": it switches to People (``goTo``) and leaves
 * this request; People opens the form when it mounts, or at once if it's
 * already showing. */
let pendingNew = false;
const newListeners = new Set<() => void>();

export function requestNewContact(): void {
  pendingNew = true;
  newListeners.forEach((f) => f());
}

/** People: call ``open`` whenever "Add contact" was asked for. */
export function useNewContactRequests(open: () => void): void {
  useEffect(() => {
    const check = () => {
      if (!pendingNew) return;
      pendingNew = false;
      open();
    };
    check();
    newListeners.add(check);
    return () => {
      newListeners.delete(check);
    };
  }, [open]);
}

// ------------------------------------------------------------------ misc

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFilename(s: string): string {
  return (s || "Contacts").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Contacts";
}

/** A titled card section in the person page. */
export function Panel({
  title,
  icon: Icon,
  action,
  children,
  className,
}: {
  title: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl border border-[var(--border)] bg-[var(--surface)]", className)}>
      <header className="flex min-h-[44px] items-center justify-between gap-2 px-4 pt-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          {Icon && <Icon className="h-4 w-4 text-[var(--item-accent)]" />}
          {title}
        </h3>
        {action}
      </header>
      <div className="px-4 pb-3 pt-1">{children}</div>
    </section>
  );
}

/** Is focus in something you type into (so single-key shortcuts stay off)? */
export function typingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

export function sheetOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"]');
}

/** The element's own width (layouts follow the space they get, not the
 *  viewport — the person page shares the screen with the list and the AI
 *  panel on a desktop). 0 until measured. */
export function useWidth(ref: RefObject<HTMLElement | null>, remeasure?: unknown): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setW((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, remeasure]);
  return w;
}

/** "3 days overdue", "5 weeks overdue", "4 months overdue". */
export function overdueLabel(days: number): string {
  if (days <= 0) return "Due today";
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} overdue`;
  if (days < 60) return `${Math.round(days / 7)} weeks overdue`;
  return `${Math.round(days / 30.4)} months overdue`;
}

// ---------------------------------------------------------------- colour

/* Contacts' blue is the app mark only (the icon in the header). Buttons,
 * selection and links inside the app use the suite's terracotta: the views
 * read ``--item-accent``, so it is pointed at ``--accent`` for this app.
 * Sheets and menus render in a portal under <html>, where the item shell
 * sets the kind's own colour, so that one is kept in step here too (and
 * handed back when the tab goes away). */
const SUITE_ACCENT = "var(--accent)";

export function ContactsTheme({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    let theirs = root.style.getPropertyValue("--item-accent");
    const apply = () => {
      const now = root.style.getPropertyValue("--item-accent");
      if (now.trim() === SUITE_ACCENT) return;
      theirs = now;
      root.style.setProperty("--item-accent", SUITE_ACCENT);
    };
    apply();
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(apply);
    mo?.observe(root, { attributes: true, attributeFilter: ["style"] });
    return () => {
      mo?.disconnect();
      if (root.style.getPropertyValue("--item-accent").trim() !== SUITE_ACCENT) return;
      if (theirs) root.style.setProperty("--item-accent", theirs);
      else root.style.removeProperty("--item-accent");
    };
  }, []);
  return (
    <div className="contents" style={{ "--item-accent": SUITE_ACCENT } as CSSProperties}>
      {children}
    </div>
  );
}
