import { EyeOff } from "lucide-react";

import { cn } from "@/utils/cn";

/** The one app-wide statement of what a server admin can and can't see
 *  (admin privacy AP9). Shown in Account → Privacy & activity, at first
 *  sign-in and in the Welcome dialog. The same words are in README.md and OVERVIEW.md §5.7:
 *  keep them in step. */
export function PrivacyStatement({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-2", className ?? "text-sm text-[var(--text)]")}>
      <p>
        In Promptly, your admin manages accounts, storage and the server. The
        app never shows them your chats, mail, files, photos, notes, tasks,
        calendar, health, location, messages or voice. They see your account,
        sign-ins, how much space and AI you use, and errors without their
        contents. They see shared things only if they&apos;re in them, like
        anyone else.
      </p>
      <p>
        Two honest limits: anyone who runs the machine itself (shell or
        database access) can read what isn&apos;t end-to-end encrypted. Only
        Passwords is. And AI features send what you ask to the AI services
        your admin set up. Each model shows whether it&apos;s local or hosted.
      </p>
      <p>
        If your admin resets your password or changes your email, you&apos;ll
        be told, and it shows under Recent activity.
      </p>
    </div>
  );
}

export function PrivacyStatementPanel() {
  return (
    <section
      id="privacy-statement"
      aria-labelledby="privacy-statement-title"
      className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4"
    >
      <h2
        id="privacy-statement-title"
        className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--text)]"
      >
        <EyeOff className="h-4 w-4" aria-hidden /> What your server admin can and can&apos;t see
      </h2>
      <PrivacyStatement className="text-[13px] leading-relaxed text-[var(--text-muted)]" />
    </section>
  );
}
