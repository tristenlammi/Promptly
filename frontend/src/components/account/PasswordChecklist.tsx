import { Check, Circle } from "lucide-react";

import { cn } from "@/utils/cn";

export interface PasswordCheck {
  key: "length" | "number" | "symbol";
  label: string;
  ok: boolean;
}

/** The server's rules (``backend/app/auth/password_policy.py``), checked as
 *  you type: the length floor, a number, and a symbol — anything that isn't
 *  a letter or a number, the same test the server uses. "Too common" and
 *  "too repetitive" only the server can say; those come back as an error. */
export function passwordChecks(pw: string, minLength: number): PasswordCheck[] {
  return [
    { key: "length", label: `At least ${minLength} characters`, ok: [...pw].length >= minLength },
    { key: "number", label: "A number", ok: /\p{N}/u.test(pw) },
    { key: "symbol", label: "A symbol, like ! @ # or -", ok: /[^\p{L}\p{N}]/u.test(pw) },
  ];
}

export function passwordMeetsRules(pw: string, minLength: number): boolean {
  return passwordChecks(pw, minLength).every((c) => c.ok);
}

/** A live checklist under a "New password" box. */
export function PasswordChecklist({ password, minLength, id }: { password: string; minLength: number; id?: string }) {
  return (
    <ul id={id} aria-label="Password rules" className="mt-1.5 flex flex-col gap-0.5 text-xs" data-testid="password-checklist">
      {passwordChecks(password, minLength).map((c) => (
        <li
          key={c.key}
          data-ok={c.ok}
          className={cn("flex items-center gap-1.5", c.ok ? "text-[var(--success)]" : "text-[var(--text-muted)]")}
        >
          {c.ok ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Circle className="h-3 w-3 shrink-0" aria-hidden />}
          <span>
            {c.label}
            <span className="sr-only">{c.ok ? " — done" : " — not yet"}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
