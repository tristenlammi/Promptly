import { CalendarPlus, CloudOff, Flag, Loader2, LogIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  formAnswerApi,
  refusalOf,
  type AnswerPage,
  type AnswerPageOpen,
  type SubmitBody,
} from "@/api/formAnswer";
import { FileAnswer, type FileMeta } from "@/components/forms/FileAnswer";
import { FormDone, FormRenderer } from "@/components/forms/FormRenderer";
import { answersOnPath, walkPath, type Answers } from "@/components/forms/logic";
import { themeVars } from "@/components/forms/theme";
import { rememberReturnTo } from "@/lib/returnTo";
import { logout } from "@/lib/session";
import { useAuthStore } from "@/store/authStore";

/**
 * ``/f/:token`` — answering a form (Forms WP-F1.3). The page people open
 * from a group chat on their phone, signed in or not.
 *
 * - The form itself is ``FormRenderer`` (the builder's preview uses the
 *   same one), in the respondent's light or dark.
 * - Answers are kept on this device as you type, so a reload or a lost
 *   signal doesn't wipe them.
 * - Sending offline waits and retries by itself; the page's ``submit_id``
 *   makes a retry the same answer, never a second one.
 * - Every other state has its own plain words: closed, sign in, already
 *   answered, and one message for every kind of dead link.
 */

const START_WAIT_MS = 3200;
const RETRY_MS = 20_000;

const GONE = "This form doesn't exist or its link was turned off.";
const BUSY = "Lots of answers are arriving. Try again in a minute.";
const OFFLINE = "You're offline. We'll send it when you're back.";

type Stored<T> = { get: () => T | null; set: (v: T) => void; clear: () => void };

/** A localStorage value that never throws (private mode, blocked storage). */
function stored<T>(key: string): Stored<T> {
  return {
    get: () => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
      } catch {
        return null;
      }
    },
    set: (v) => {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage full or blocked: the answer is still on screen */
      }
    },
    clear: () => {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** A random UUID, also on plain-http addresses (no ``crypto.randomUUID``). */
function uuid4(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

interface Draft {
  answers: Answers;
  email: string;
  /** Names of the files picked so far (they're kept on the server). */
  files?: Record<string, FileMeta>;
}
interface Pending {
  kind: "submit" | "change";
  body: SubmitBody;
}
interface Done {
  changed: boolean;
  editToken: string | null;
}

type View =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "error"; message: string }
  | { kind: "page"; page: AnswerPage };

export function FormAnswerPage() {
  const { token = "" } = useParams<{ token: string }>();
  const [params, setParams] = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const uid = user?.id ?? "anon";

  const keys = useMemo(
    () => ({
      draft: stored<Draft>(`promptly.form-draft.${token}.${uid}`),
      pending: stored<Pending>(`promptly.form-pending.${token}.${uid}`),
      // This device answered (the soft one-per-device check on link forms).
      done: stored<{ at: string }>(`promptly.form-done.${token}`),
      edit: stored<string>(`promptly.form-edit.${token}`),
      // This page's key for the files it picked (they're the server's until sent).
      fileKey: stored<string>(`promptly.form-files.${token}.${uid}`),
    }),
    [token, uid]
  );

  const [view, setView] = useState<View>({ kind: "loading" });
  const [mode, setMode] = useState<"form" | "already" | "done">("form");
  const [done, setDone] = useState<Done | null>(null);
  const [editing, setEditing] = useState<{ answers: Answers; email: string; edit: string | null; when: string | null } | null>(null);
  const [run, setRun] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string> | null>(null);
  // Files in the answers: names and sizes, by upload id.
  const [files, setFiles] = useState<Record<string, FileMeta>>(() => keys.draft.get()?.files ?? {});
  const filesRef = useRef(files);
  filesRef.current = files;
  const busyFiles = useRef<Set<string>>(new Set());
  const fileKey = useRef<string>(keys.fileKey.get() ?? "");
  if (!fileKey.current) {
    fileKey.current = uuid4().replace(/-/g, "");
    keys.fileKey.set(fileKey.current);
  }
  const startAt = useRef(Date.now());
  const startToken = useRef("");
  const submitId = useRef(keys.pending.get()?.body.submit_id ?? uuid4());
  const honeypot = useRef<HTMLInputElement>(null);
  const draftTimer = useRef<number | null>(null);
  // Opened from a saved "change your answer" link.
  const cameToEdit = useRef(!!params.get("edit"));

  // A saved edit link (?edit=…): kept on this device, then out of the address bar.
  useEffect(() => {
    const e = params.get("edit");
    if (e) {
      keys.edit.set(e);
      const next = new URLSearchParams(params);
      next.delete("edit");
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async (): Promise<AnswerPage | null> => {
    try {
      const page = await formAnswerApi.get(token);
      if (page.state === "open") {
        startToken.current = page.start_token;
        startAt.current = Date.now();
      }
      setView({ kind: "page", page });
      return page;
    } catch (err) {
      const { status } = refusalOf(err);
      if (status === 404) setView({ kind: "gone" });
      else if (status === 429) setView({ kind: "error", message: BUSY });
      else setView({ kind: "error", message: "This form couldn't be loaded. Check your connection and try again." });
      return null;
    }
  }, [token]);

  // First load: where to start (the form, "already answered", or an answer
  // that was waiting to be sent).
  useEffect(() => {
    void (async () => {
      const page = await load();
      if (!page || page.state !== "open") return;
      const pending = keys.pending.get();
      if (pending) {
        void deliver(page, pending);
        return;
      }
      if (cameToEdit.current && page.settings.allow_edit && (page.respondent ? page.answered : keys.edit.get())) {
        cameToEdit.current = false;
        void startEditing(page);
        return;
      }
      if (page.settings.one_per_person && (page.answered || (!page.respondent && keys.done.get()))) setMode("already");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, uid]);

  useEffect(() => {
    if (view.kind === "page" && view.page.state !== "sign_in") {
      const t = view.page.definition.title || "Untitled form";
      document.title = t;
    }
  }, [view]);

  // An answer waiting for a connection: sent when the device is back online,
  // and tried again every so often in case "online" never fires.
  useEffect(() => {
    if (!offline) return;
    const retry = () => {
      const pending = keys.pending.get();
      if (pending && view.kind === "page") void deliver(view.page, pending);
    };
    window.addEventListener("online", retry);
    const t = window.setInterval(retry, RETRY_MS);
    return () => {
      window.removeEventListener("online", retry);
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline, view]);

  const deliver = async (page: AnswerPage, pending: Pending, attempt = 0): Promise<void> => {
    if (page.state !== "open") return;
    keys.pending.set(pending);
    setSending(true);
    setSendError(null);
    setFieldErrors(null);
    pending = { ...pending, body: { ...pending.body, draft_key: pending.body.draft_key ?? fileKey.current } };
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setOffline(true);
      setSending(false);
      setSendError(OFFLINE);
      return;
    }
    // Answers sent back within 3 seconds of opening are refused (spam);
    // a quick person just waits a moment here.
    const wait = START_WAIT_MS - (Date.now() - startAt.current);
    if (wait > 0) await sleep(wait);
    try {
      const body = { ...pending.body, start_token: startToken.current || pending.body.start_token };
      if (pending.kind === "change") {
        await formAnswerApi.change(token, body);
        finish({ changed: true, editToken: body.edit ?? null }, page);
      } else {
        const res = await formAnswerApi.submit(token, body);
        if (res.edit_token) keys.edit.set(res.edit_token);
        finish({ changed: false, editToken: res.edit_token }, page);
      }
    } catch (err) {
      const { status, refusal } = refusalOf(err);
      if (status === null) {
        // No answer at all: offline, or the server's unreachable. Keep it and retry.
        setOffline(true);
        setSendError(OFFLINE);
        return;
      }
      setOffline(false);
      if (status === 401 && attempt < 1) {
        // The sign-in ran out and couldn't be renewed: start again with the page as it is now.
        keys.pending.clear();
        await load();
        setSendError("Your sign-in ran out. Check your answers and send again.");
        return;
      }
      if (status === 429 || refusal?.code === "busy") {
        keys.pending.clear();
        setSendError(BUSY);
        return;
      }
      const code = refusal?.code;
      if ((code === "too_fast" || code === "start_expired" || code === "bad_start") && attempt < 2) {
        if (code !== "too_fast") {
          const fresh = await load();
          if (!fresh || fresh.state !== "open") {
            keys.pending.clear();
            return;
          }
          startToken.current = fresh.start_token;
          startAt.current = Date.now() - START_WAIT_MS;
        } else {
          await sleep(2000);
        }
        return deliver(page, pending, attempt + 1);
      }
      keys.pending.clear();
      if (status === 404 || code === "gone") {
        setView({ kind: "gone" });
      } else if (code === "closed" || code === "sign_in") {
        await load();
      } else if (code === "already_answered") {
        setMode("already");
      } else if (code === "full" && refusal?.question_id) {
        // Someone took the last place first: show it, with fresh places left.
        setFieldErrors({ [refusal.question_id]: refusal.message });
        setSendError(refusal.message);
        const fresh = await load();
        if (fresh?.state === "open") startAt.current = Date.now() - START_WAIT_MS;
      } else if (code === "invalid" && refusal?.question_id) {
        setFieldErrors({ [refusal.question_id]: refusal.message });
        setSendError(refusal.message);
      } else {
        setSendError(refusal?.message ?? "Your answer couldn't be sent. Try again.");
      }
    } finally {
      setSending(false);
    }
  };

  const finish = (d: Done, page: AnswerPage) => {
    keys.pending.clear();
    keys.draft.clear();
    if (page.state === "open" && !page.respondent) keys.done.set({ at: new Date().toISOString() });
    submitId.current = uuid4();
    // The files went with the answer: a fresh key for the next one.
    fileKey.current = uuid4().replace(/-/g, "");
    keys.fileKey.set(fileKey.current);
    setFiles({});
    setOffline(false);
    setSendError(null);
    setEditing(null);
    setDone(d);
    setMode("done");
    window.scrollTo({ top: 0 });
    document.getElementById("form-answer-scroll")?.scrollTo({ top: 0 });
  };

  const onSubmit = (page: AnswerPageOpen) => (answers: Answers, _path: number[], email?: string) => {
    if (busyFiles.current.size) {
      setSendError("Wait for your files to finish uploading, then send.");
      return;
    }
    const onPath = answersOnPath(page.definition, answers, walkPath(page.definition, answers));
    const body: SubmitBody = {
      answers: onPath as Record<string, unknown>,
      submit_id: submitId.current,
      start_token: startToken.current,
      draft_key: fileKey.current,
      ...(email ? { email } : {}),
      ...(honeypot.current?.value ? { website: honeypot.current.value } : {}),
    };
    if (editing) {
      if (editing.edit) body.edit = editing.edit;
      return deliver(page, { kind: "change", body });
    }
    return deliver(page, { kind: "submit", body });
  };

  const startEditing = async (page: AnswerPageOpen) => {
    setSendError(null);
    try {
      const edit = page.respondent ? null : keys.edit.get();
      const mine = page.respondent && page.mine ? { ...page.mine, start_token: page.start_token } : await formAnswerApi.mine(token, edit);
      startToken.current = mine.start_token;
      startAt.current = Date.now();
      setFiles((prev) => ({ ...prev, ...(mine.files ?? {}) }));
      setEditing({ answers: mine.answers as Answers, email: mine.email ?? "", edit, when: mine.edited_at ?? mine.submitted_at });
      setMode("form");
      setRun((n) => n + 1);
    } catch (err) {
      const { status, refusal } = refusalOf(err);
      if (status === 404) {
        keys.edit.clear();
        setSendError("That answer can't be changed any more.");
      } else setSendError(refusal?.message ?? "Your answer couldn't be loaded. Try again.");
    }
  };

  const onFileBusy = useCallback((questionId: string, busy: boolean) => {
    if (busy) busyFiles.current.add(questionId);
    else busyFiles.current.delete(questionId);
  }, []);

  const anotherAnswer = () => {
    setDone(null);
    setEditing(null);
    setMode("form");
    setRun((n) => n + 1);
    void load();
  };

  // ------------------------------------------------------------------ render
  if (view.kind === "loading")
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center py-24" style={{ color: "var(--pf-muted)" }}>
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading the form" />
        </div>
      </Shell>
    );
  if (view.kind === "gone") return <Message title="Form not found" text={GONE} />;
  if (view.kind === "error")
    return (
      <Message title="Couldn't open the form" text={view.message}>
        <button type="button" className="pf-btn pf-btn-primary self-start" onClick={() => void load()}>
          Try again
        </button>
      </Message>
    );

  const page = view.page;
  if (page.state === "sign_in") {
    const here = `/f/${token}`;
    return (
      <Message title="Sign in to answer" text={`This form is for people on ${window.location.hostname}. Sign in to answer it.`}>
        <Link
          to={`/login?next=${encodeURIComponent(here)}`}
          onClick={() => rememberReturnTo(here)}
          className="pf-btn pf-btn-primary self-start"
        >
          <LogIn className="h-4 w-4" aria-hidden="true" /> Sign in
        </Link>
      </Message>
    );
  }
  const accent = page.definition.theme?.accent;
  if (page.state === "closed")
    return (
      <Shell accent={accent}>
        <FormDone
          definition={page.definition}
          assetUrls={page.asset_urls}
          scheme="device"
          message={page.closed_message || "This form isn't taking answers any more."}
        />
        <Footer token={token} link={page.audience === "link"} />
      </Shell>
    );

  const s = page.settings;
  const signedIn = !!page.respondent;
  const canChange = s.allow_edit && (signedIn ? page.answered || !!page.mine : !!keys.edit.get());

  if (mode === "done" && done) {
    const editUrl = done.editToken && s.allow_edit && !signedIn ? `${window.location.origin}/f/${token}?edit=${done.editToken}` : null;
    return (
      <Shell accent={accent}>
        <FormDone
          definition={page.definition}
          assetUrls={page.asset_urls}
          scheme="device"
          message={done.changed ? "Your changes are saved." : s.confirmation || "Your answer has been sent."}
        >
          {editUrl && <EditLink url={editUrl} />}
          <div className="flex flex-wrap gap-2">
            {s.allow_edit && (signedIn || done.editToken) && (
              <button type="button" className="pf-btn pf-btn-ghost border" style={{ borderColor: "var(--pf-border)" }} onClick={() => void load().then((p) => (p?.state === "open" ? startEditing(p) : undefined))}>
                Change your answer
              </button>
            )}
            {page.event && <AddToCalendar token={token} title={page.event.title} />}
            {s.allow_another && !(s.one_per_person && signedIn) && (
              <button type="button" className="pf-btn pf-btn-ghost border" style={{ borderColor: "var(--pf-border)" }} onClick={anotherAnswer}>
                Send another answer
              </button>
            )}
          </div>
        </FormDone>
        <Footer token={token} link={page.audience === "link"} />
      </Shell>
    );
  }

  if (mode === "already")
    return (
      <Shell accent={accent}>
        <FormDone
          definition={page.definition}
          assetUrls={page.asset_urls}
          scheme="device"
          message={signedIn ? "You've already answered this form." : "You've already answered this form on this device."}
        >
          {sendError && (
            <p role="alert" className="text-sm" style={{ color: "var(--pf-error)" }}>
              {sendError}
            </p>
          )}
          {canChange && (
            <button type="button" className="pf-btn pf-btn-primary self-start" onClick={() => void startEditing(page)}>
              Change your answer
            </button>
          )}
        </FormDone>
        <Footer token={token} link={page.audience === "link"} />
      </Shell>
    );

  const draft = editing ? null : keys.draft.get();
  const notice = (
    <div className="flex flex-col gap-1">
      {signedIn && (
        <span>
          Answering as <strong className="font-semibold" style={{ color: "var(--pf-text)" }}>{page.respondent!.name}</strong> ·{" "}
          <button
            type="button"
            className="pf-link underline"
            onClick={() => {
              rememberReturnTo(`/f/${token}`);
              void logout();
            }}
          >
            Not you?
          </button>
        </span>
      )}
      {page.audience === "link" && <span>Don&apos;t put passwords or bank details in a form.</span>}
      {editing && (
        <span>
          You&apos;re changing your answer
          {editing.when ? ` from ${new Date(editing.when).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""}.{" "}
          <button type="button" className="pf-link underline" onClick={anotherAnswer}>
            Cancel
          </button>
        </span>
      )}
      {!editing && !signedIn && !s.one_per_person && s.allow_edit && keys.edit.get() && (
        <span>
          You&apos;ve answered on this device before.{" "}
          <button type="button" className="pf-link underline" onClick={() => void startEditing(page)}>
            Change that answer
          </button>
        </span>
      )}
      {!editing && signedIn && page.answered && !s.one_per_person && s.allow_edit && (
        <span>
          You&apos;ve answered before.{" "}
          <button type="button" className="pf-link underline" onClick={() => void startEditing(page)}>
            Change that answer
          </button>
        </span>
      )}
    </div>
  );

  return (
    <Shell accent={accent}>
      {/* The honeypot: hidden from people and screen readers; a bot that
          fills in every box fills this one too. */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", top: "auto", width: 1, height: 1, overflow: "hidden" }}>
        <label>
          Website
          <input ref={honeypot} type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>
      {offline && (
        <div role="status" className="mx-auto mt-3 flex w-full max-w-[42rem] items-center gap-2 px-4 text-sm" style={{ color: "var(--pf-muted)" }}>
          <CloudOff className="h-4 w-4 shrink-0" aria-hidden="true" /> {OFFLINE}
        </div>
      )}
      <FormRenderer
        key={`${run}-${editing ? "edit" : "new"}`}
        definition={page.definition}
        assetUrls={page.asset_urls}
        mode="answer"
        scheme="device"
        remaining={page.remaining}
        showRemaining={s.show_remaining}
        initialAnswers={editing ? editing.answers : draft?.answers}
        onAnswersChange={(a) => {
          if (editing) return;
          if (draftTimer.current) window.clearTimeout(draftTimer.current);
          draftTimer.current = window.setTimeout(() => {
            const prev = keys.draft.get();
            if (!Object.keys(a).length && !prev?.email) keys.draft.clear();
            else keys.draft.set({ answers: a, email: prev?.email ?? "", files: filesRef.current });
          }, 250);
        }}
        askEmail={s.collect_email && !(editing && signedIn)}
        initialEmail={editing ? editing.email : draft?.email}
        onEmailChange={(email) => {
          if (editing) return;
          const prev = keys.draft.get();
          keys.draft.set({ answers: prev?.answers ?? {}, email, files: prev?.files });
        }}
        notice={notice}
        onSubmit={onSubmit(page)}
        submitting={sending}
        submitError={sendError}
        submitLabel={editing ? "Save changes" : "Submit"}
        fieldErrors={fieldErrors}
        renderUpload={(item, value, onChange) => (
          <FileAnswer
            token={token}
            draftKey={fileKey.current}
            item={item}
            accept={page.uploads?.accept?.[item.id] ?? ""}
            value={value}
            onChange={onChange}
            files={files}
            onFiles={(update) =>
              setFiles((prev) => {
                const next = update(prev);
                filesRef.current = next;
                if (!editing) {
                  const d = keys.draft.get();
                  if (d) keys.draft.set({ ...d, files: next });
                }
                return next;
              })
            }
            onBusy={onFileBusy}
          />
        )}
        footer={<FooterLinks token={token} link={page.audience === "link"} />}
        className="flex-1"
      />
    </Shell>
  );
}

/** The page around everything: the form's look, light or dark like the device. */
function Shell({ children, accent }: { children: ReactNode; accent?: string }) {
  return (
    <div
      id="form-answer-scroll"
      className="pf-theme flex h-[100dvh] flex-col overflow-y-auto"
      data-scheme="device"
      style={themeVars(accent ?? "terracotta")}
    >
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}

function Message({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-3 px-4 py-6 sm:py-10">
        <div className="h-3 rounded-full sm:h-4" style={{ background: "var(--pf-band)" }} aria-hidden="true" />
        <div className="pf-card flex flex-col gap-3 px-4 py-5 sm:px-6">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-[15px]" role="status">
            {text}
          </p>
          {children}
        </div>
        <p className="text-center text-xs" style={{ color: "var(--pf-muted)" }}>
          Made with Promptly
        </p>
      </div>
    </Shell>
  );
}

/** "Add to my calendar": the event this RSVP is for, as an .ics file. */
function AddToCalendar({ token, title }: { token: string; title: string }) {
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const go = async () => {
    setState("busy");
    try {
      const blob = await formAnswerApi.ics(token);
      const url = URL.createObjectURL(new Blob([blob], { type: "text/calendar" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title.replace(/[^\w \-]+/g, "").trim() || "event"}.ics`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setState("idle");
    } catch {
      setState("error");
    }
  };
  return (
    <>
      <button type="button" className="pf-btn pf-btn-ghost border" style={{ borderColor: "var(--pf-border)" }} onClick={() => void go()} disabled={state === "busy"}>
        <CalendarPlus className="h-4 w-4" aria-hidden="true" /> Add to my calendar
      </button>
      {state === "error" && (
        <p role="alert" className="w-full text-sm" style={{ color: "var(--pf-error)" }}>
          The event couldn&apos;t be downloaded. Try again.
        </p>
      )}
    </>
  );
}

/** "Save this link to change your answer later", with Copy. */
function EditLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard (plain http): select it so a long-press copies it.
      field.current?.select();
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: "var(--pf-hover)" }}>
      <label htmlFor="form-edit-link" className="text-sm font-medium">
        Save this link to change your answer later
      </label>
      <div className="flex gap-2">
        <input ref={field} id="form-edit-link" readOnly value={url} className="pf-input min-w-0 flex-1 text-sm" onFocus={(e) => e.target.select()} />
        <button type="button" className="pf-btn pf-btn-primary shrink-0" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-xs" style={{ color: "var(--pf-muted)" }}>
        It&apos;s kept on this device too. Anyone with the link can change your answer, so keep it to yourself.
      </p>
    </div>
  );
}

function Footer({ token, link }: { token: string; link: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[42rem] px-4 pb-6 pt-2 text-center text-xs" style={{ color: "var(--pf-muted)" }}>
      <FooterLinks token={token} link={link} />
    </div>
  );
}

/** "Made with Promptly", and Report this form on link forms. */
function FooterLinks({ token, link }: { token: string; link: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const send = async () => {
    setState("sending");
    try {
      await formAnswerApi.report(token, reason.trim());
      setState("sent");
    } catch (err) {
      setState(refusalOf(err).status === 429 ? "sent" : "error");
    }
  };
  return (
    <div className="flex flex-col items-center gap-2">
      <p>
        Made with Promptly
        {link && (
          <>
            {" · "}
            <button
              type="button"
              className="inline-flex min-h-[44px] items-center gap-1 underline"
              aria-expanded={open}
              aria-controls="form-report"
              onClick={() => setOpen((o) => !o)}
            >
              <Flag className="h-3.5 w-3.5" aria-hidden="true" /> Report this form
            </button>
          </>
        )}
      </p>
      {link && open && (
        <div id="form-report" className="pf-card flex w-full flex-col gap-2 p-4 text-left text-sm" style={{ color: "var(--pf-text)" }}>
          {state === "sent" ? (
            <p role="status">Thanks. The people who run this server have been told.</p>
          ) : (
            <>
              <label htmlFor="form-report-reason" className="font-medium">
                What&apos;s wrong with this form?
              </label>
              <textarea
                id="form-report-reason"
                className="pf-input min-h-[5rem]"
                maxLength={1000}
                placeholder="For example: it asks for a password, or it's pretending to be someone else."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              {state === "error" && (
                <p role="alert" style={{ color: "var(--pf-error)" }}>
                  The report couldn&apos;t be sent. Try again.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" className="pf-btn pf-btn-ghost" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button type="button" className="pf-btn pf-btn-primary" disabled={state === "sending"} onClick={() => void send()}>
                  {state === "sending" ? "Sending…" : "Send report"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
