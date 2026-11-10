import { Check, Copy, Loader2, Mail, Share2 } from "lucide-react";
import { useState } from "react";

import { adminApi } from "@/api/admin";
import { apiErrorMessage } from "@/utils/apiError";

export interface NewMember {
  id: string;
  username: string;
  email: string;
  /** The password the admin just typed. Held only in this card's state. */
  password: string;
  /** They'll be asked to choose their own on first sign-in. */
  temporary: boolean;
}

/** The words the card shows — and Copy / Share / Email send. Kept in step
 *  with ``welcome_email_text`` in ``backend/app/admin/router.py``. */
export function newMemberText(m: NewMember, address: string): string {
  return [
    `Hi ${m.username},`,
    "",
    "You've got an account on our family's Promptly — a private space for messages, photos, calendar, notes and an AI helper.",
    "",
    `Address: ${address}`,
    `Username: ${m.username}`,
    `${m.temporary ? "Temporary password" : "Password"}: ${m.password}`,
    "",
    "1. Open the address and sign in.",
    m.temporary ? "2. Choose your own password." : "2. You're in.",
    "3. On an iPhone, open it in Safari, then tap Share → Add to Home Screen.",
    "   On Android, tap Install when your phone offers it.",
  ].join("\n");
}

/** Shown after Create user: everything the new person needs, to copy,
 *  share or email. The password is shown here once and kept nowhere else. */
export function NewMemberCard({ member, smtpConfigured }: { member: NewMember; smtpConfigured: boolean }) {
  const address = location.origin;
  const text = newMemberText(member, address);
  const [copied, setCopied] = useState(false);
  const [emailState, setEmailState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const copy = async () => {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — select the details and copy them by hand.");
    }
  };

  const share = async () => {
    setError(null);
    try {
      await navigator.share({ title: "Your Promptly account", text });
    } catch (e) {
      // Closing the share sheet isn't an error.
      if ((e as DOMException)?.name !== "AbortError") setError("Couldn't open sharing — use Copy instead.");
    }
  };

  const email = async () => {
    setError(null);
    setEmailState("sending");
    try {
      await adminApi.sendWelcomeEmail(member.id, { address, password: member.password });
      setEmailState("sent");
    } catch (e) {
      setEmailState("idle");
      setError(apiErrorMessage(e, "Couldn't send the email. Copy or share the details instead."));
    }
  };

  const row = (label: string, value: string, testId: string) => (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <dt className="w-40 shrink-0 text-xs text-[var(--text-muted)]">{label}</dt>
      <dd className="break-all font-mono text-sm text-[var(--text)]" data-testid={testId}>
        {value}
      </dd>
    </div>
  );

  const btn =
    "inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-3.5 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-60";

  return (
    <div className="flex flex-col gap-4" data-testid="new-member-card">
      <p className="text-sm text-[var(--text)]">
        <b>{member.username}</b>&apos;s account is ready. Send them these details — they won&apos;t get anything
        otherwise.
      </p>
      <dl className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        {row("Address", address, "new-member-address")}
        {row("Username", member.username, "new-member-username")}
        {row(member.temporary ? "Temporary password" : "Password", member.password, "new-member-password")}
      </dl>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-[var(--text)]">
        <li>Open this address and sign in.</li>
        {member.temporary && <li>Choose your own password.</li>}
        <li>
          iPhone: open it in <b>Safari</b>, then <b>Share → Add to Home Screen</b>. Android: tap <b>Install</b> when
          the phone offers it.
        </li>
      </ol>
      <p className="text-xs text-[var(--text-muted)]">
        This is the only time the password is shown. If it gets lost, use Reset password on their row.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void copy()} className={btn}>
          {copied ? <Check className="h-4 w-4 text-[var(--success)]" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
        {canShare && (
          <button type="button" onClick={() => void share()} className={btn}>
            <Share2 className="h-4 w-4" aria-hidden /> Share
          </button>
        )}
        {smtpConfigured && (
          <button
            type="button"
            onClick={() => void email()}
            disabled={emailState !== "idle"}
            className={btn}
            data-testid="new-member-email"
          >
            {emailState === "sending" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : emailState === "sent" ? (
              <Check className="h-4 w-4 text-[var(--success)]" aria-hidden />
            ) : (
              <Mail className="h-4 w-4" aria-hidden />
            )}
            {emailState === "sent" ? `Emailed to ${member.email}` : "Email it to them"}
          </button>
        )}
      </div>
      <p aria-live="polite" className="text-xs text-[var(--danger)]">
        {error}
      </p>
    </div>
  );
}
