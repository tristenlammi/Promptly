import { useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Link2, RefreshCw } from "lucide-react";
import { useState } from "react";

import { calendarApi, feedUrls, type CalendarBootstrap } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { confirm } from "@/components/shared/ConfirmDialog";
import { ItemButton, Sheet } from "@/items/ui";
import { toast } from "@/store/toastStore";

import { BOOTSTRAP_KEY } from "../data";

/** The private, read-only ICS link for phone calendar apps. */
export function SubscribeSheet({ open, onClose, b }: { open: boolean; onClose: () => void; b: CalendarBootstrap }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const token = b.feed_token;
  const urls = token ? feedUrls(token) : null;

  const setToken = (feed_token: string | null) => qc.setQueryData<CalendarBootstrap>(BOOTSTRAP_KEY, (old) => (old ? { ...old, feed_token } : old));

  const make = async (reset: boolean) => {
    if (reset && !(await confirm({ title: "Reset the link?", message: "The old link stops working — apps using it need the new one.", confirmLabel: "Reset link", danger: true }))) return;
    setBusy(true);
    try {
      const r = await calendarApi.makeFeed();
      setToken(r.feed_token);
      if (reset) toast.success("New link made");
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setBusy(false);
    }
  };

  const off = async () => {
    if (!(await confirm({ title: "Turn off the link?", message: "Apps subscribed to it stop getting your events.", confirmLabel: "Turn off", danger: true }))) return;
    setBusy(true);
    try {
      await calendarApi.dropFeed();
      setToken(null);
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!urls) return;
    try {
      await navigator.clipboard.writeText(urls.https);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy — select the link and copy it.");
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Subscribe in your phone's calendar">
      <div className="flex flex-col gap-4 pt-1 text-sm text-[var(--text)]">
        <p className="text-[var(--text-muted)]">
          A private, read-only link to your events — the ones on your calendars and the ones you're going to. Your phone's calendar app checks it every so often. Anyone with the link can see your
          events, so keep it to yourself.
        </p>

        {!urls ? (
          <ItemButton variant="primary" icon={<Link2 className="h-4 w-4" />} disabled={busy} onClick={() => void make(false)}>
            Create link
          </ItemButton>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 pl-3">
              <input readOnly value={urls.https} onFocus={(e) => e.currentTarget.select()} aria-label="Subscribe link" className="min-w-0 flex-1 bg-transparent font-mono text-xs text-[var(--text)] outline-none" />
              <ItemButton size="sm" variant="primary" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => void copy()}>
                Copy
              </ItemButton>
            </div>
            <a
              href={urls.webcal}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]"
            >
              <ExternalLink className="h-4 w-4" />
              Open in calendar app
            </a>
            <div className="flex gap-2">
              <ItemButton block size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} disabled={busy} onClick={() => void make(true)}>
                Reset link
              </ItemButton>
              <ItemButton block size="sm" variant="ghost" className="text-[var(--danger)]" disabled={busy} onClick={() => void off()}>
                Turn off
              </ItemButton>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2 rounded-xl bg-[var(--surface-2)] p-3 text-xs text-[var(--text-muted)]">
          <p>
            <span className="font-semibold text-[var(--text)]">Google Calendar:</span> on a computer, Other calendars → + → From URL, and paste the link.
          </p>
          <p>
            <span className="font-semibold text-[var(--text)]">iPhone:</span> Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, and paste the link (or tap “Open in
            calendar app”).
          </p>
          <p>Changes can take a while to show up — the apps decide how often to check.</p>
        </div>
      </div>
    </Sheet>
  );
}
