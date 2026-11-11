import Link from "@tiptap/extension-link";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, FolderOpen, Italic, Link as LinkIcon, List, ListOrdered, Loader2, Minus, Paperclip, Send, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { filesApi } from "@/api/files";
import { MyFilesPicker } from "@/components/admin/MyFilesPicker";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSelectedModel } from "@/store/modelStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { FromAliasRow } from "./Aliases";
import { mailApi, personName, type OutgoingFile, type Person } from "./api";

const MAX_FILES_BYTES = 25 * 1024 * 1024;

export interface Draft {
  account_id: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html?: string;
  reply_to?: string;
  forward_of?: string;
  thread_key?: string;
  // What the sent email will include below what you write.
  quoting?: string;
  files?: OutgoingFile[];
  fromFiles?: { id: string; name: string }[];
  // A reply to mail sent to one of your aliases goes out from that alias.
  from_alias?: string;
  from_alias_note?: string;
}

/** Which draft this is: one per email you're answering, and one new message. */
export function draftId(d: Draft): string {
  return d.reply_to ?? d.forward_of ?? "new";
}

function draftKey(d: Draft): string {
  return `mail-draft:${draftId(d)}`;
}

function fileBytes(f: OutgoingFile): number {
  return Math.floor((f.data.length * 3) / 4);
}

function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function loadDraft(d: Draft): Partial<Draft> {
  try {
    return JSON.parse(localStorage.getItem(draftKey(d)) ?? "{}") as Partial<Draft>;
  } catch {
    return {};
  }
}

function saveDraft(d: Draft, values: Partial<Draft> | null) {
  try {
    if (values) localStorage.setItem(draftKey(d), JSON.stringify(values));
    else localStorage.removeItem(draftKey(d));
  } catch {
    // A convenience: without storage you just don't get your draft back.
  }
}

function addresses(raw: string): string[] {
  return raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function asParagraphs(text: string): string {
  return text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replaceAll("\n", "<br>")}</p>`).join("");
}

/** An address box that suggests people you've emailed before. */
function PeopleInput({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [found, setFound] = useState<Person[]>([]);
  const [focused, setFocused] = useState(false);
  const typing = value.split(/[,;\s]+/).pop() ?? "";
  useEffect(() => {
    if (!focused || typing.length < 2) {
      setFound([]);
      return;
    }
    const t = window.setTimeout(() => void mailApi.people(typing).then(setFound).catch(() => setFound([])), 150);
    return () => window.clearTimeout(t);
  }, [typing, focused]);
  const pick = (p: Person) => {
    onChange(`${value.slice(0, value.length - typing.length)}${p.addr}, `);
    setFound([]);
  };
  return (
    <div className="relative">
      <label className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <span className="w-8 shrink-0">{label}</span>
        <input autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => window.setTimeout(() => setFocused(false), 150)} onKeyDown={(e) => { if (e.key === "Escape" && found.length > 0) { e.stopPropagation(); setFound([]); } }} aria-label={label} autoComplete="off" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-[var(--text)] outline-none" />
      </label>
      {found.length > 0 && (
        <div role="listbox" className="promptly-scroll absolute inset-x-0 top-full z-10 max-h-52 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl">
          {found.map((p) => (
            <button key={p.addr} type="button" role="option" aria-selected="false" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} className="block w-full truncate px-3 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]">
              {p.name ? <>{personName(p)} <span className="text-[var(--text-muted)]">{p.addr}</span></> : p.addr}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const button = (active: boolean) => `flex h-10 w-10 shrink-0 items-center md:h-8 md:w-8 justify-center rounded-lg ${active ? "bg-[var(--accent)]/15 text-[var(--accent-text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`;
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const link = () => {
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    setUrl("");
    setLinking((v) => !v);
  };
  const addLink = () => {
    let href = url.trim();
    if (!href) return setLinking(false);
    // "example.com" and "sam@example.com" are what people actually type.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) href = /^[^\s@/]+@[^\s@/]+$/.test(href) ? `mailto:${href}` : `https://${href}`;
    if (!/^(https?:|mailto:)/i.test(href)) {
      toast.error("That doesn't look like a web or email address.");
      return;
    }
    editor.chain().focus().setLink({ href }).run();
    setLinking(false);
  };
  return (
    <>
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold" aria-pressed={editor.isActive("bold")} className={button(editor.isActive("bold"))}><Bold className="h-4 w-4" /></button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic" aria-pressed={editor.isActive("italic")} className={button(editor.isActive("italic"))}><Italic className="h-4 w-4" /></button>
      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} aria-label="Bullet list" aria-pressed={editor.isActive("bulletList")} className={button(editor.isActive("bulletList"))}><List className="h-4 w-4" /></button>
      <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} aria-label="Numbered list" aria-pressed={editor.isActive("orderedList")} className={button(editor.isActive("orderedList"))}><ListOrdered className="h-4 w-4" /></button>
      <span className="relative">
        <button type="button" onClick={link} aria-label={editor.isActive("link") ? "Remove link" : "Link"} title={editor.isActive("link") ? "Remove link" : "Link"} aria-pressed={editor.isActive("link")} aria-expanded={linking} className={button(editor.isActive("link") || linking)}><LinkIcon className="h-4 w-4" /></button>
        {linking && (
          <form
            onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); addLink(); }}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setLinking(false); editor.commands.focus(); } }}
            className="absolute bottom-full left-0 z-10 mb-2 flex w-72 max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl"
          >
            <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste or type a link" aria-label="Link address" autoComplete="off" className="h-9 min-w-0 flex-1 rounded-lg bg-[var(--hover)] px-2.5 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]" />
            <button type="submit" className="h-9 shrink-0 rounded-lg bg-[var(--accent)] px-3 text-xs font-medium text-white">Add</button>
          </form>
        )}
      </span>
    </>
  );
}

/** One draft in the dock: open to write in, or minimised to a bar you can come back to. */
export function Composer({ draft, accounts, minimised = false, slot = 0, onClose, onMinimise, onExpand, onSent }: {
  draft: Draft;
  accounts: { id: string; email: string; signature: string }[];
  minimised?: boolean;
  /** Where it sits among the minimised ones, on a phone. */
  slot?: number;
  onClose: () => void;
  onMinimise: () => void;
  onExpand: () => void;
  onSent: (sendId: string, seconds: number, snapshot: Draft) => void;
}) {
  const isMobile = useIsMobile();
  // What you were writing here before, unless this was reopened by undo.
  const saved = useRef(draft.html ? {} : loadDraft(draft)).current;
  const [account, setAccount] = useState(draft.reply_to || draft.forward_of ? draft.account_id : saved.account_id ?? draft.account_id);
  const [to, setTo] = useState(saved.to || draft.to);
  const [cc, setCc] = useState(saved.cc ?? draft.cc ?? "");
  const [bcc, setBcc] = useState(saved.bcc ?? draft.bcc ?? "");
  const [showCc, setShowCc] = useState(Boolean(saved.cc || saved.bcc || draft.cc || draft.bcc));
  const [subject, setSubject] = useState(saved.subject ?? draft.subject);
  const [files, setFiles] = useState<OutgoingFile[]>(draft.files ?? []);
  const [fromFiles, setFromFiles] = useState(draft.fromFiles ?? []);
  const [fromAlias, setFromAlias] = useState(draft.from_alias ?? "");
  const [choosing, setChoosing] = useState(false);
  const [sending, setSending] = useState(false);
  const [asking, setAsking] = useState(false);
  const [wish, setWish] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const model = useSelectedModel();
  const signature = accounts.find((a) => a.id === account)?.signature;

  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false }), Link.configure({ openOnClick: false, protocols: ["https", "http", "mailto"] })],
    content: draft.html ?? saved.html ?? "",
    autofocus: draft.to ? "end" : false,
    editorProps: { attributes: { class: "promptly-prose min-h-[9rem] py-2 text-sm text-[var(--text)] outline-none", "aria-label": "Message" } },
  });

  // Close it, come back, carry on. Attachments aren't kept: they could be huge.
  const values = (): Partial<Draft> => ({ account_id: account, to, cc, bcc, subject, html: editor?.getHTML() ?? "" });
  const keep = () => {
    const v = values();
    const blank = !editor?.getText().trim() && v.to === draft.to && v.subject === draft.subject;
    saveDraft(draft, blank ? null : v);
  };
  useEffect(() => {
    const t = window.setInterval(keep, 3000);
    return () => window.clearInterval(t);
  });

  // Back from the dock: carry on where the cursor was.
  const wasMinimised = useRef(minimised);
  useEffect(() => {
    if (wasMinimised.current && !minimised) editor?.commands.focus();
    wasMinimised.current = minimised;
  }, [minimised, editor]);

  const addFiles = async (picked: FileList | File[] | null) => {
    const list = [...(picked ?? [])];
    if (list.length === 0) return;
    const size = [...files.map(fileBytes), ...list.map((f) => f.size)].reduce((a, b) => a + b, 0);
    if (size > MAX_FILES_BYTES) return toast.error("Attachments can be up to 25 MB in all. Most mail servers refuse more.");
    const read = await Promise.all(list.map((f) => new Promise<OutgoingFile>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: f.name || "Pasted file", mime: f.type || "application/octet-stream", data: String(reader.result).split(",")[1] ?? "" });
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(f);
    }))).catch(() => null);
    if (read) setFiles((v) => [...v, ...read]);
    else toast.error("Couldn't read that file.");
  };

  const addFromFiles = async (ids: string[]) => {
    setChoosing(false);
    const found = await Promise.all(ids.map((id) => filesApi.getFile(id).then((f) => ({ id, name: f.filename })))).catch(() => null);
    if (found) setFromFiles((v) => [...v, ...found.filter((f) => !v.some((x) => x.id === f.id))]);
    else toast.error("Couldn't get those files.");
  };

  const write = async () => {
    if (!model) return toast.error("Pick a model first, in the bar below.");
    setDrafting(true);
    try {
      const { text } = await mailApi.draft({ provider_id: model.provider_id, model_id: model.model_id, account_id: account, thread_key: draft.thread_key, instruction: wish, subject });
      editor?.commands.setContent(asParagraphs(text));
      setAsking(false);
      setWish("");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't write a draft."));
    } finally {
      setDrafting(false);
    }
  };

  const send = async () => {
    const people = addresses(to);
    if (!people.length && !addresses(cc).length && !addresses(bcc).length) return toast.error("Add someone to send this to.");
    setSending(true);
    try {
      const html = editor?.getHTML() ?? "";
      const sent = await mailApi.send({
        account_id: account, to: people, cc: addresses(cc), bcc: addresses(bcc), subject, text: editor?.getText({ blockSeparator: "\n\n" }) ?? "", html,
        reply_to_message: draft.reply_to, forward_of: draft.forward_of, files, file_ids: fromFiles.map((f) => f.id), from_alias: fromAlias || undefined,
      });
      saveDraft(draft, null);
      onSent(sent.id, sent.undo_seconds, { ...draft, account_id: account, to, cc, bcc, subject, html, files, fromFiles });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't send that. Check the addresses."));
      setSending(false);
    }
  };

  const title = draft.reply_to ? "Reply" : draft.forward_of ? "Forward" : "New message";
  const blank = () => !editor?.getText().trim() && to === draft.to && subject === draft.subject && files.length + fromFiles.length === 0;
  // Esc puts it away without losing anything. Nothing written, nothing to keep.
  const putAway = () => {
    if (blank()) {
      saveDraft(draft, null);
      onClose();
    } else {
      keep();
      onMinimise();
    }
  };
  const headButton = "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-8 md:w-8";
  const shape = minimised
    ? (isMobile
      ? "absolute left-3 z-20 flex max-w-[65%] items-center rounded-full border border-[var(--border)] bg-[var(--surface)] shadow-lg"
      : "pointer-events-auto flex w-64 shrink-0 items-center rounded-t-xl border border-b-0 border-[var(--border)] bg-[var(--surface)] shadow-lg")
    : (isMobile
      ? "absolute inset-x-0 bottom-0 z-30 flex max-h-[92%] flex-col rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
      : "pointer-events-auto relative flex max-h-full w-[560px] min-w-0 shrink flex-col rounded-t-2xl border border-b-0 border-[var(--border)] bg-[var(--surface)] shadow-2xl");
  return (
    <div
      role="group"
      aria-label={title}
      data-mail-composer
      style={minimised && isMobile ? { bottom: `calc(7.5rem + ${slot * 3.25}rem)` } : undefined}
      onKeyDown={(e) => {
        if (minimised) return;
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); }
        else if (e.key === "Escape" && !choosing && !e.defaultPrevented) { e.stopPropagation(); putAway(); }
      }}
      onDragOver={(e) => { if (!minimised && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => {
        if (minimised || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(false);
        void addFiles(e.dataTransfer.files);
      }}
      onPaste={(e) => {
        // A copied picture or file. Copied words keep going to the message.
        const got = [...e.clipboardData.files];
        const words = e.clipboardData.types.includes("text/plain") || e.clipboardData.types.includes("text/html");
        if (got.length === 0 || words) return;
        e.preventDefault();
        void addFiles(got);
      }}
      className={shape}
    >
      {minimised ? (
        <>
          <button type="button" onClick={onExpand} title="Carry on writing" className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-l-[inherit] pl-3.5 pr-1 text-left text-sm font-medium text-[var(--text)]">
            <span className="min-w-0 flex-1 truncate">{subject.trim() || title}</span>
          </button>
          <button type="button" onClick={() => { keep(); onClose(); }} aria-label={`Close ${subject.trim() || title} and keep it`} title="Close. It'll be here when you come back" className="mr-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-8 md:w-8 md:rounded-lg"><X className="h-4 w-4" /></button>
        </>
      ) : (
        <div className="flex shrink-0 items-center justify-between pl-4 pr-2 pt-2">
          <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--text)]">{title}</h2>
          <div className="flex shrink-0 items-center gap-0.5">
            <button type="button" onClick={() => { saveDraft(draft, null); onClose(); }} aria-label="Discard" title="Discard" className={headButton}><Trash2 className="h-4 w-4" /></button>
            <button type="button" onClick={() => { keep(); onMinimise(); }} aria-label="Minimise" title="Minimise (Esc)" className={headButton}><Minus className="h-4 w-4" /></button>
            <button type="button" onClick={() => { keep(); onClose(); }} aria-label="Close and keep" title="Close. It'll be here when you come back" className={headButton}><X className="h-4 w-4" /></button>
          </div>
        </div>
      )}
      {/* Still here while minimised, so what you wrote and attached is too. */}
      <div className={minimised ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
      {over && (
        <div aria-hidden className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))] text-sm font-medium text-[var(--text)]">Drop to attach</div>
      )}
      <div className="promptly-scroll min-h-0 flex-1 divide-y divide-[var(--border)] overflow-y-auto px-4">
        {draft.from_alias && (
          <div>
            <FromAliasRow alias={draft.from_alias} accountEmail={accounts.find((a) => a.id === account)?.email ?? ""} value={fromAlias} onChange={setFromAlias} />
            {fromAlias && draft.from_alias_note && <p className="pb-2 text-xs text-[var(--warning)]">{draft.from_alias_note}</p>}
          </div>
        )}
        {/* A reply or forward goes from the mailbox the email is in, so it stays in that conversation. */}
        {accounts.length > 1 && !draft.from_alias && !draft.reply_to && !draft.forward_of && (
          <label className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <span className="w-8 shrink-0">From</span>
            <select value={account} onChange={(e) => setAccount(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-[var(--text)] outline-none">
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
            </select>
          </label>
        )}
        <div className="flex items-start">
          <div className="min-w-0 flex-1"><PeopleInput label="To" value={to} onChange={setTo} autoFocus={!to} /></div>
          {!showCc && <button type="button" onClick={() => setShowCc(true)} className="py-2 pl-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">Cc Bcc</button>}
        </div>
        {showCc && <PeopleInput label="Cc" value={cc} onChange={setCc} />}
        {showCc && <PeopleInput label="Bcc" value={bcc} onChange={setBcc} />}
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" className="w-full bg-transparent py-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]" />
        <div>
          {asking && (
            <form className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--accent)]/10 p-2" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setAsking(false); } }} onSubmit={(e) => { e.preventDefault(); void write(); }}>
              <input autoFocus value={wish} onChange={(e) => setWish(e.target.value)} placeholder={draft.reply_to ? "What should the reply say? (optional)" : "What's this email about?"} aria-label="What should it say" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]" />
              <button type="submit" disabled={drafting} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-xs font-medium text-white disabled:opacity-60">{drafting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Write it</button>
              <button type="button" onClick={() => setAsking(false)} aria-label="Cancel" className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-muted)]"><X className="h-4 w-4" /></button>
            </form>
          )}
          <EditorContent editor={editor} />
          {signature && <p className="whitespace-pre-wrap pb-2 text-xs text-[var(--text-muted)]">-- {"\n"}{signature}</p>}
          {draft.quoting && <p className="pb-2 text-xs text-[var(--text-muted)]">{draft.quoting}</p>}
          {files.length + fromFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-2">
              {fromFiles.map((f) => (
                <span key={f.id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[var(--hover)] p-1 text-xs text-[var(--text)]">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center"><FolderOpen className="h-3.5 w-3.5" /></span><span className="min-w-0 truncate">{f.name}</span>
                  <button type="button" onClick={() => setFromFiles((v) => v.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.name}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--text)]"><X className="h-3.5 w-3.5" /></button>
                </span>
              ))}
              {files.map((f, i) => (
                <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[var(--hover)] p-1 text-xs text-[var(--text)]">
                  {f.mime.startsWith("image/") && f.mime !== "image/svg+xml"
                    ? <img src={`data:${f.mime};base64,${f.data}`} alt="" className="h-7 w-7 shrink-0 rounded-md object-cover" />
                    : <span className="flex h-7 w-7 shrink-0 items-center justify-center"><Paperclip className="h-3.5 w-3.5" /></span>}
                  <span className="min-w-0 truncate">{f.name}</span>
                  <span className="shrink-0 text-[var(--text-muted)]">{sizeWords(fileBytes(f))}</span>
                  <button type="button" onClick={() => setFiles((v) => v.filter((_, n) => n !== i))} aria-label={`Remove ${f.name}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:text-[var(--text)]"><X className="h-3.5 w-3.5" /></button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5 border-t border-[var(--border)] px-2 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:pb-2">
        {editor && <Toolbar editor={editor} />}
        <input ref={picker} type="file" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
        <button type="button" onClick={() => picker.current?.click()} aria-label="Attach files" title="Attach files" className="flex h-10 w-10 shrink-0 items-center md:h-8 md:w-8 justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"><Paperclip className="h-4 w-4" /></button>
        <button type="button" onClick={() => setChoosing(true)} aria-label="Attach from Files" title="Attach from Files" className="flex h-10 w-10 shrink-0 items-center md:h-8 md:w-8 justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"><FolderOpen className="h-4 w-4" /></button>
        <button type="button" onClick={() => setAsking((v) => !v)} aria-label="Draft with AI" title={model ? `Draft with ${model.model_id}` : "Draft with AI"} className="flex h-10 w-10 shrink-0 items-center md:h-8 md:w-8 justify-center rounded-lg text-[var(--accent-text)] hover:bg-[var(--hover)]"><Sparkles className="h-4 w-4" /></button>
        <span className="flex-1" />
        <button type="button" onClick={() => void send()} disabled={sending} title="Send (Ctrl+Enter)" className="inline-flex h-10 shrink-0 items-center md:h-9 gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"><Send className="h-4 w-4" />Send</button>
      </div>
      </div>
      <MyFilesPicker open={choosing} onClose={() => setChoosing(false)} onConfirm={(ids) => void addFromFiles(ids)} title="Attach from Files" description="They go with this email when you send it." verb="Attach" excludeIds={new Set(fromFiles.map((f) => f.id))} />
    </div>
  );
}
