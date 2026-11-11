import Link from "@tiptap/extension-link";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, FolderOpen, Italic, Link as LinkIcon, List, ListOrdered, Loader2, Paperclip, Send, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { filesApi } from "@/api/files";
import { MyFilesPicker } from "@/components/admin/MyFilesPicker";
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

function draftKey(d: Draft): string {
  return `mail-draft:${d.reply_to ?? d.forward_of ?? "new"}`;
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
        <input autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => window.setTimeout(() => setFocused(false), 150)} aria-label={label} autoComplete="off" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-[var(--text)] outline-none" />
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
  const button = (active: boolean) => `flex h-8 w-8 items-center justify-center rounded-lg ${active ? "bg-[#D97757]/15 text-[#D97757]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"}`;
  const link = () => {
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const url = window.prompt("Link address");
    if (url && /^(https?:|mailto:)/i.test(url.trim())) editor.chain().focus().setLink({ href: url.trim() }).run();
    else if (url) toast.error("Links need to start with https:// or mailto:");
  };
  return (
    <>
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold" aria-pressed={editor.isActive("bold")} className={button(editor.isActive("bold"))}><Bold className="h-4 w-4" /></button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic" aria-pressed={editor.isActive("italic")} className={button(editor.isActive("italic"))}><Italic className="h-4 w-4" /></button>
      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()} aria-label="Bullet list" aria-pressed={editor.isActive("bulletList")} className={button(editor.isActive("bulletList"))}><List className="h-4 w-4" /></button>
      <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()} aria-label="Numbered list" aria-pressed={editor.isActive("orderedList")} className={button(editor.isActive("orderedList"))}><ListOrdered className="h-4 w-4" /></button>
      <button type="button" onClick={link} aria-label="Link" aria-pressed={editor.isActive("link")} className={button(editor.isActive("link"))}><LinkIcon className="h-4 w-4" /></button>
    </>
  );
}

export function Composer({ draft, accounts, onClose, onSent }: {
  draft: Draft;
  accounts: { id: string; email: string; signature: string }[];
  onClose: () => void;
  onSent: (sendId: string, seconds: number, snapshot: Draft) => void;
}) {
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

  const addFiles = async (picked: FileList | null) => {
    const list = [...(picked ?? [])];
    const size = [...files.map((f) => (f.data.length * 3) / 4), ...list.map((f) => f.size)].reduce((a, b) => a + b, 0);
    if (size > MAX_FILES_BYTES) return toast.error("Attachments can be up to 25 MB in all. Most mail servers refuse more.");
    const read = await Promise.all(list.map((f) => new Promise<OutgoingFile>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: f.name, mime: f.type || "application/octet-stream", data: String(reader.result).split(",")[1] ?? "" });
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
  return (
    <div
      role="dialog"
      aria-label={title}
      onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }}
      className="absolute inset-x-0 bottom-0 z-30 flex max-h-[92%] flex-col rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl md:inset-x-auto md:bottom-4 md:right-4 md:max-h-[85%] md:w-[560px] md:rounded-2xl"
    >
      <div className="flex items-center justify-between px-4 pt-3">
        <h2 className="text-sm font-semibold text-[var(--text)]">{title}</h2>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => { saveDraft(draft, null); onClose(); }} aria-label="Discard" title="Discard" className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"><Trash2 className="h-4 w-4" /></button>
          <button type="button" onClick={() => { keep(); onClose(); }} aria-label="Close and keep" title="Close. It'll be here when you come back" className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"><X className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="promptly-scroll min-h-0 flex-1 divide-y divide-[var(--border)] overflow-y-auto px-4">
        {draft.from_alias && (
          <div>
            <FromAliasRow alias={draft.from_alias} accountEmail={accounts.find((a) => a.id === account)?.email ?? ""} value={fromAlias} onChange={setFromAlias} />
            {fromAlias && draft.from_alias_note && <p className="pb-2 text-xs text-[#C9A227]">{draft.from_alias_note}</p>}
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
            <form className="mt-2 flex items-center gap-2 rounded-lg bg-[#D97757]/10 p-2" onSubmit={(e) => { e.preventDefault(); void write(); }}>
              <input autoFocus value={wish} onChange={(e) => setWish(e.target.value)} placeholder={draft.reply_to ? "What should the reply say? (optional)" : "What's this email about?"} aria-label="What should it say" className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]" />
              <button type="submit" disabled={drafting} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#D97757] px-3 text-xs font-medium text-white disabled:opacity-60">{drafting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Write it</button>
              <button type="button" onClick={() => setAsking(false)} aria-label="Cancel" className="text-[var(--text-muted)]"><X className="h-4 w-4" /></button>
            </form>
          )}
          <EditorContent editor={editor} />
          {signature && <p className="whitespace-pre-wrap pb-2 text-xs text-[var(--text-muted)]">-- {"\n"}{signature}</p>}
          {draft.quoting && <p className="pb-2 text-xs text-[var(--text-muted)]">{draft.quoting}</p>}
          {files.length + fromFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-2">
              {fromFiles.map((f) => (
                <span key={f.id} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[var(--hover)] px-2 py-1 text-xs text-[var(--text)]">
                  <FolderOpen className="h-3 w-3 shrink-0" /><span className="truncate">{f.name}</span>
                  <button type="button" onClick={() => setFromFiles((v) => v.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.name}`} className="text-[var(--text-muted)]"><X className="h-3 w-3" /></button>
                </span>
              ))}
              {files.map((f, i) => (
                <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-[var(--hover)] px-2 py-1 text-xs text-[var(--text)]">
                  <Paperclip className="h-3 w-3 shrink-0" /><span className="truncate">{f.name}</span>
                  <button type="button" onClick={() => setFiles((v) => v.filter((_, n) => n !== i))} aria-label={`Remove ${f.name}`} className="text-[var(--text-muted)]"><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5 border-t border-[var(--border)] px-2 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:pb-2">
        {editor && <Toolbar editor={editor} />}
        <input ref={picker} type="file" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
        <button type="button" onClick={() => picker.current?.click()} aria-label="Attach files" title="Attach files" className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"><Paperclip className="h-4 w-4" /></button>
        <button type="button" onClick={() => setChoosing(true)} aria-label="Attach from Files" title="Attach from Files" className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"><FolderOpen className="h-4 w-4" /></button>
        <button type="button" onClick={() => setAsking((v) => !v)} aria-label="Draft with AI" title={model ? `Draft with ${model.model_id}` : "Draft with AI"} className="flex h-8 w-8 items-center justify-center rounded-lg text-[#D97757] hover:bg-[var(--hover)]"><Sparkles className="h-4 w-4" /></button>
        <span className="flex-1" />
        <button type="button" onClick={() => void send()} disabled={sending} className="inline-flex h-9 items-center gap-2 rounded-xl bg-[#D97757] px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"><Send className="h-4 w-4" />Send</button>
      </div>
      <MyFilesPicker open={choosing} onClose={() => setChoosing(false)} onConfirm={(ids) => void addFromFiles(ids)} title="Attach from Files" description="They go with this email when you send it." verb="Attach" excludeIds={new Set(fromFiles.map((f) => f.id))} />
    </div>
  );
}
