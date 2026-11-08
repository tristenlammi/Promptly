import { AlertTriangle, Check, Copy, Download, Globe, Link2Off, RefreshCw, Send, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DirectoryUser } from "@/api/auth";
import { formsApi, type FormView } from "@/api/forms";
import { Button } from "@/components/shared/Button";
import { Callout } from "@/components/shared/Callout";
import { UserPicker, type UserPickerValue } from "@/components/shared/UserPicker";
import { Sheet } from "@/items/ui/Sheet";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { fieldCls } from "./ui";

/**
 * Send (Forms WP-F1.3): the form's answer link with Copy and a QR code (a
 * PNG for a flyer), Reset link and Turn off; sending it to people on this
 * server (a notification that opens it); and adding collaborators, who edit
 * the form and see its answers. A bottom sheet on a phone.
 *
 * The link is made the first time this opens. It's for answering only:
 * opening it never gives anyone the form itself.
 */
export function SendDialog({
  open,
  onClose,
  fileId,
  view,
  onView,
  isOwner,
  onAccepting,
  onOpenSettings,
  onShare,
}: {
  open: boolean;
  onClose: () => void;
  fileId: string;
  view: FormView;
  onView: (v: FormView) => void;
  isOwner: boolean;
  onAccepting: (on: boolean) => Promise<void> | void;
  onOpenSettings: () => void;
  onShare: () => void;
}) {
  const [busy, setBusy] = useState<null | "make" | "reset" | "off">(null);
  const [error, setError] = useState<string | null>(null);
  // Reset / Turn off ask first, inside the sheet (a separate confirm dialog
  // would open underneath it).
  const [asking, setAsking] = useState<null | "reset" | "off">(null);
  const tried = useRef(false);
  const link = view.link;
  const s = view.form.settings;
  const url = link ? `${window.location.origin}${link.url}` : "";

  const makeLink = async (reset = false) => {
    setBusy(reset ? "reset" : "make");
    setError(null);
    try {
      onView(await formsApi.makeLink(fileId, reset));
      if (reset) toast.success("New link made. The old one doesn't work any more.");
    } catch (e) {
      setError(apiErrorMessage(e, "The link couldn't be made."));
    } finally {
      setBusy(null);
    }
  };

  // The first time Send opens, there's a link to copy straight away.
  useEffect(() => {
    if (open && !link && !tried.current) {
      tried.current = true;
      void makeLink(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, link]);

  const reset = async () => {
    setAsking(null);
    await makeLink(true);
  };
  const turnOff = async () => {
    setAsking(null);
    setBusy("off");
    try {
      onView(await formsApi.turnOffLink(fileId));
      tried.current = true;
      toast.success("Link turned off");
    } catch (e) {
      toast.error(apiErrorMessage(e, "The link couldn't be turned off."));
    } finally {
      setBusy(null);
    }
  };

  const now = Date.now();
  const closedBy =
    s.close_at && new Date(s.close_at).getTime() <= now
      ? "Its closing time has passed, so it isn't taking answers."
      : s.max_responses !== null && view.form.response_count >= s.max_responses
        ? "It has all the answers you asked for, so it isn't taking more."
        : null;
  // File questions people without an account won't be asked (link forms).
  const fileQuestions =
    s.audience === "link"
      ? view.form.definition.items.filter(
          (i) =>
            !i.deleted &&
            i.kind === "file_upload" &&
            (!s.allow_uploads_from_link || !(i.config as { kinds: string[] }).kinds.some((k) => k === "images" || k === "pdf"))
        )
      : [];

  return (
    <Sheet open={open} onClose={onClose} title="Send" size="md">
      <div className="flex flex-col gap-5 px-4 pb-5 pt-1 sm:px-5" data-form-send>
        {!s.accepting ? (
          <Callout tone="warning" className="flex flex-col gap-2">
            <span>This form isn&apos;t taking answers yet. People with the link will see that it&apos;s closed.</span>
            <Button size="sm" variant="primary" className="self-start" onClick={() => void onAccepting(true)}>
              Start taking answers
            </Button>
          </Callout>
        ) : closedBy ? (
          <Callout tone="warning">
            {closedBy}{" "}
            <button type="button" className="font-medium underline" onClick={onOpenSettings}>
              Change it in Settings
            </button>
          </Callout>
        ) : null}
        {s.audience === "link" && !view.link_answers_allowed && (
          <Callout tone="warning">
            Your server&apos;s admin has turned off answers from people without an account, so this link doesn&apos;t work
            for now. Switch to “People on this server” in Settings to use it.
          </Callout>
        )}

        <div className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
          <span className="mt-0.5 text-[var(--text-muted)]" aria-hidden="true">
            {s.audience === "link" ? <Globe className="h-5 w-5" /> : <Users className="h-5 w-5" />}
          </span>
          <p className="min-w-0 flex-1 text-sm text-[var(--text)]">
            {s.audience === "link" ? (
              <>
                <strong className="font-semibold">Anyone with the link</strong> can answer, without an account.
              </>
            ) : (
              <>
                <strong className="font-semibold">People on this server</strong> can answer. They sign in first, so you
                see who answered.
              </>
            )}{" "}
            <button type="button" className="font-medium text-[var(--accent-text)] underline" onClick={onOpenSettings}>
              Change
            </button>
          </p>
        </div>

        {fileQuestions.length > 0 && (
          <p className="flex gap-2 text-xs text-[var(--text-muted)]">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              People without an account won&apos;t be asked{" "}
              {fileQuestions.map((q) => `“${q.title || "Untitled question"}”`).join(", ")}:{" "}
              {s.allow_uploads_from_link
                ? "they can only send pictures and PDFs."
                : "letting them send files is off in Settings."}{" "}
              People who sign in are.
            </span>
          </p>
        )}

        <section aria-labelledby="send-link-h" className="flex flex-col gap-2">
          <h3 id="send-link-h" className="text-sm font-semibold text-[var(--text)]">
            Link
          </h3>
          {link ? (
            <>
              <CopyField url={url} />
              <QrBlock url={url} name={view.form.definition.title || "form"} />
              {asking ? (
                <div role="alertdialog" aria-labelledby="send-ask-h" className="flex flex-col gap-2 rounded-lg border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3 text-sm">
                  <p id="send-ask-h" className="font-medium text-[var(--text)]">
                    {asking === "reset" ? "Reset the link?" : "Turn off the link?"}
                  </p>
                  <p className="text-[var(--text-muted)]">
                    {asking === "reset"
                      ? "The link you've sent stops working, and a new one is made. Anyone who still needs to answer will need the new link."
                      : "People opening it will be told the form doesn't exist. You can make a new link any time."}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="danger" autoFocus onClick={() => void (asking === "reset" ? reset() : turnOff())}>
                      {asking === "reset" ? "Reset link" : "Turn off"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" loading={busy === "reset"} onClick={() => setAsking("reset")}>
                    <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reset link
                  </Button>
                  <Button size="sm" variant="ghost" loading={busy === "off"} onClick={() => setAsking("off")}>
                    <Link2Off className="h-4 w-4" aria-hidden="true" /> Turn off link
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col gap-2">
              {error && <Callout tone="danger">{error}</Callout>}
              <Button size="sm" variant="primary" className="self-start" loading={busy === "make"} onClick={() => void makeLink(false)}>
                Make the link
              </Button>
            </div>
          )}
        </section>

        <SendToPeople fileId={fileId} onLink={() => void formsApi.get(fileId).then(onView).catch(() => undefined)} />

        {isOwner && (
          <section aria-labelledby="send-collab-h" className="flex flex-col gap-1.5 border-t border-[var(--border)] pt-4">
            <h3 id="send-collab-h" className="text-sm font-semibold text-[var(--text)]">
              Add collaborators
            </h3>
            <p className="text-xs text-[var(--text-muted)]">People you add can edit the form and see all its answers.</p>
            <Button size="sm" variant="secondary" className="self-start" onClick={onShare}>
              <Users className="h-4 w-4" aria-hidden="true" /> Add collaborators
            </Button>
          </section>
        )}
      </div>
    </Sheet>
  );
}

function CopyField({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard here (a plain-http address): select it to copy by hand.
      field.current?.select();
      toast.info("Select the link and copy it.");
    }
  };
  return (
    <div className="flex gap-2">
      <input
        ref={field}
        readOnly
        aria-label="Answer link"
        value={url}
        className={`${fieldCls} h-10 min-w-0 flex-1 font-mono text-xs`}
        onFocus={(e) => e.target.select()}
      />
      <Button variant="primary" onClick={() => void copy()}>
        {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** The link as a QR code, and a big PNG of it for a flyer. */
function QrBlock({ url, name }: { url: string; name: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    void import("qrcode").then((QR) =>
      QR.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: "M" }).then((d) => live && setSrc(d))
    );
    return () => {
      live = false;
    };
  }, [url]);
  const download = async () => {
    const QR = await import("qrcode");
    const big = await QR.toDataURL(url, { margin: 2, width: 1024, errorCorrectionLevel: "M" });
    const a = document.createElement("a");
    a.href = big;
    a.download = `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "form"} QR code.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  return (
    <div className="flex items-center gap-3">
      {src ? (
        <img src={src} alt="QR code for the answer link" width={112} height={112} className="rounded-md border border-[var(--border)] bg-white p-1" />
      ) : (
        <div className="h-[112px] w-[112px] animate-pulse rounded-md bg-[var(--surface-2)]" aria-hidden="true" />
      )}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-[var(--text-muted)]">People can scan it with their phone camera.</p>
        <Button size="sm" variant="secondary" className="self-start" onClick={() => void download()}>
          <Download className="h-4 w-4" aria-hidden="true" /> Download QR code
        </Button>
      </div>
    </div>
  );
}

/** People on this server: each gets a notification that opens the form. */
function SendToPeople({ fileId, onLink }: { fileId: string; onLink: () => void }) {
  const [who, setWho] = useState<UserPickerValue>(null);
  const [people, setPeople] = useState<DirectoryUser[]>([]);
  const [sending, setSending] = useState(false);
  const add = (v: UserPickerValue) => {
    if (v?.kind === "user") {
      setPeople((p) => (p.some((x) => x.user_id === v.user.user_id) ? p : [...p, v.user]));
      setWho(null);
    } else setWho(v);
  };
  const send = async () => {
    if (!people.length) return;
    setSending(true);
    try {
      const { sent } = await formsApi.send(
        fileId,
        people.map((p) => p.user_id)
      );
      toast.success(sent === 1 ? "Sent to 1 person" : `Sent to ${sent} people`);
      setPeople([]);
      onLink();
    } catch (e) {
      toast.error(apiErrorMessage(e, "The form couldn't be sent."));
    } finally {
      setSending(false);
    }
  };
  return (
    <section aria-labelledby="send-people-h" className="flex flex-col gap-2 border-t border-[var(--border)] pt-4">
      <h3 id="send-people-h" className="text-sm font-semibold text-[var(--text)]">
        Send to people on this server
      </h3>
      <p className="text-xs text-[var(--text-muted)]">They get a notification that opens the form. It doesn&apos;t let them change it.</p>
      <UserPicker
        value={who}
        onChange={add}
        excludeUserIds={people.map((p) => p.user_id)}
        placeholder="Add someone by name"
      />
      {people.length > 0 && (
        <ul aria-label="People to send to" className="flex flex-wrap gap-1.5">
          {people.map((p) => (
            <li key={p.user_id} className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] py-1 pl-3 pr-1 text-sm text-[var(--text)]">
              {p.username}
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-[var(--hover)]"
                aria-label={`Don't send to ${p.username}`}
                onClick={() => setPeople((list) => list.filter((x) => x.user_id !== p.user_id))}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" variant="primary" className="self-start" disabled={!people.length} loading={sending} onClick={() => void send()}>
        <Send className="h-4 w-4" aria-hidden="true" /> Send
      </Button>
    </section>
  );
}
