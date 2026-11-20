import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, FileText, Globe, Paperclip, Search, StickyNote, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { studyApi, studyError, type Depth, type Level } from "@/api/study";
import { AttachmentPickerModal, type AttachedFile } from "@/components/chat/AttachmentPickerModal";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { Sheet } from "@/components/shared/Sheet";
import { notesApi } from "@/notes/api";
import { cn } from "@/utils/cn";

import { DEPTH_WORDS, LEVEL_WORDS } from "../ui/bits";
import "../study.css";

/* New subject: what, why, how deep, who is learning, and what to read. */

const IDEAS = ["How tides work", "The basics of investing", "Photosynthesis", "How the internet works", "Music theory for guitar", "The French Revolution"];
const MAX_FILES = 5;
const MAX_NOTES = 10;

interface PickedNote {
  id: string;
  title: string;
}

export function NewSubjectPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const prefs = useQuery({ queryKey: ["study", "prefs"], queryFn: studyApi.prefs, staleTime: 60_000 });
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [prior, setPrior] = useState("");
  const [depth, setDepth] = useState<Depth>("solid");
  const [level, setLevel] = useState<Level | null>(null);
  const [useWeb, setUseWeb] = useState(true);
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [notes, setNotes] = useState<PickedNote[]>([]);
  const [filePicker, setFilePicker] = useState(false);
  const [notePicker, setNotePicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const who = level ?? prefs.data?.level ?? "adult";
  const ok = title.trim().length >= 2;
  const nothingToRead = !useWeb && files.length === 0 && notes.length === 0;

  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await studyApi.create({
        title: title.trim(),
        goal: goal.trim(),
        prior: prior.trim(),
        depth,
        level: who,
        use_web: useWeb,
        file_ids: files.map((f) => f.id),
        note_ids: notes.map((n) => n.id),
      });
      // Remember who is learning for next time.
      if (prefs.data && prefs.data.level !== who) void studyApi.setPrefs(who).then(() => qc.invalidateQueries({ queryKey: ["study", "prefs"] })).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: ["study", "subjects"] });
      navigate(`/study/${s.id}`, { replace: true });
    } catch (e) {
      setError(studyError(e));
      setBusy(false);
    }
  };

  return (
    <div className="study flex min-h-0 flex-1 flex-col">
      <TopNav
        title={
          <span className="flex min-w-0 items-center gap-1">
            <Link to="/study" aria-label="Back to your subjects" className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <span className="truncate text-base font-semibold text-[var(--text)]">New subject</span>
          </span>
        }
      />
      <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
        <form
          className="mx-auto flex w-full max-w-xl flex-col gap-7 px-4 pb-10 pt-6 sm:px-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-2">
            <label htmlFor="study-title" className="text-xl font-semibold text-[var(--text)]">
              What do you want to learn?
            </label>
            <input
              id="study-title"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 200))}
              autoFocus
              autoComplete="off"
              placeholder="A subject, a skill, a question…"
              className="h-14 w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 text-[17px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--st-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--st-soft)]"
            />
            {!title && (
              <div className="flex flex-wrap gap-1.5" aria-label="Ideas">
                {IDEAS.map((x) => (
                  <button key={x} type="button" onClick={() => setTitle(x)} className="rounded-full border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-muted)] hover:border-[var(--st-accent)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]">
                    {x}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="study-goal" className="text-[15px] font-semibold text-[var(--text)]">
              Why? <span className="font-normal text-[var(--text-muted)]">(if you like)</span>
            </label>
            <p className="text-sm text-[var(--text-muted)]">What you want it for. The examples and the focus follow from this.</p>
            <textarea
              id="study-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value.slice(0, 1000))}
              rows={2}
              placeholder="I sail, and want to plan around the tides"
              className="w-full resize-y rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5 text-[16px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--st-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--st-soft)]"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="study-prior" className="text-[15px] font-semibold text-[var(--text)]">
              What do you already know? <span className="font-normal text-[var(--text-muted)]">(if you like)</span>
            </label>
            <textarea
              id="study-prior"
              value={prior}
              onChange={(e) => setPrior(e.target.value.slice(0, 1000))}
              rows={2}
              placeholder="I know the moon is involved, not much else"
              className="w-full resize-y rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5 text-[16px] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--st-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--st-soft)]"
            />
          </div>

          <Choices legend="How far do you want to go?" value={depth} onChange={setDepth} options={(Object.keys(DEPTH_WORDS) as Depth[]).map((d) => ({ value: d, ...DEPTH_WORDS[d] }))} />

          <Choices
            legend="Who is learning?"
            hint="Sets how the teacher talks, and what's suitable."
            value={who}
            onChange={(l) => setLevel(l)}
            options={(Object.keys(LEVEL_WORDS) as Level[]).map((l) => ({ value: l, ...LEVEL_WORDS[l] }))}
            cols
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="text-[15px] font-semibold text-[var(--text)]">What should the teacher read first?</legend>
            <p className="text-sm text-[var(--text-muted)]">The course is taught from real sources, and shows you which.</p>
            <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5">
              <Globe className="h-5 w-5 shrink-0 text-[var(--text-muted)]" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium text-[var(--text)]">Research the web</span>
                <span className="block text-sm text-[var(--text-muted)]">A few searches about your subject. Nothing about you is sent.</span>
              </span>
              <input type="checkbox" role="switch" checked={useWeb} onChange={(e) => setUseWeb(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--accent)]" />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => setFilePicker(true)} disabled={files.length >= MAX_FILES} leftIcon={<Paperclip className="h-4 w-4" />}>
                Add your files
              </Button>
              <Button type="button" onClick={() => setNotePicker(true)} leftIcon={<StickyNote className="h-4 w-4" />}>
                Add your notes
              </Button>
            </div>
            {(files.length > 0 || notes.length > 0) && (
              <ul className="flex flex-col gap-1.5" aria-label="Added to read">
                {files.map((f) => (
                  <Picked key={f.id} icon={<FileText className="h-4 w-4" />} name={f.filename} onRemove={() => setFiles(files.filter((x) => x.id !== f.id))} />
                ))}
                {notes.map((n) => (
                  <Picked key={n.id} icon={<StickyNote className="h-4 w-4" />} name={n.title || "Untitled note"} onRemove={() => setNotes(notes.filter((x) => x.id !== n.id))} />
                ))}
              </ul>
            )}
            {nothingToRead && <p className="text-sm text-[var(--st-warn)]">With nothing to read, the teacher works from what it already knows. That's fine for well-known subjects; less sure for niche ones.</p>}
          </fieldset>

          {error && (
            <div role="alert" className="rounded-2xl border border-[var(--st-bad-border)] bg-[var(--st-bad-bg)] p-3.5 text-sm text-[var(--st-bad)]">
              {error.message}
              {error.code === "no_model" && <span className="mt-1 block text-[var(--text-muted)]">An admin can set one in Admin → Models.</span>}
            </div>
          )}

          <Button type="submit" variant="primary" size="lg" className="h-14 rounded-full text-base" disabled={!ok} loading={busy} rightIcon={<ArrowRight className="h-5 w-5" />} data-testid="study-build">
            Build my course
          </Button>
        </form>
      </div>

      <AttachmentPickerModal
        open={filePicker}
        onClose={() => setFilePicker(false)}
        alreadyAttached={files}
        onAttach={(picked) => {
          const seen = new Set(files.map((f) => f.id));
          setFiles([...files, ...picked.filter((f) => !seen.has(f.id))].slice(0, MAX_FILES));
          setFilePicker(false);
        }}
      />
      <NotePicker open={notePicker} onClose={() => setNotePicker(false)} picked={notes} onChange={setNotes} />
    </div>
  );
}

function Choices<T extends string>({
  legend,
  hint,
  value,
  onChange,
  options,
  cols,
}: {
  legend: string;
  hint?: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; name: string; detail: string }[];
  cols?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-[15px] font-semibold text-[var(--text)]">{legend}</legend>
      {hint && <p className="text-sm text-[var(--text-muted)]">{hint}</p>}
      <div role="radiogroup" aria-label={legend} className={cn("grid gap-2", cols ? "grid-cols-3" : "sm:grid-cols-3")}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-2xl border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]",
              cols && "text-center",
              value === o.value ? "border-[var(--st-accent)] bg-[var(--st-soft)]" : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--st-accent)]"
            )}
          >
            <span className={cn("block text-[15px] font-semibold", value === o.value ? "text-[var(--st-accent-text)]" : "text-[var(--text)]")}>{o.name}</span>
            <span className="mt-0.5 block text-xs leading-snug text-[var(--text-muted)]">{o.detail}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Picked({ icon, name, onRemove }: { icon: React.ReactNode; name: string; onRemove: () => void }) {
  return (
    <li className="flex items-center gap-2 rounded-xl bg-[var(--hover)] py-1 pl-3 pr-1 text-sm text-[var(--text)]">
      <span className="shrink-0 text-[var(--text-muted)]" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]">
        <X className="h-4 w-4" />
      </button>
    </li>
  );
}

/** Your own notes (the ones you own), to tick. */
function NotePicker({ open, onClose, picked, onChange }: { open: boolean; onClose: () => void; picked: PickedNote[]; onChange: (n: PickedNote[]) => void }) {
  const [q, setQ] = useState("");
  const [words, setWords] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setWords(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const list = useQuery({
    queryKey: ["study", "note-picker", words],
    queryFn: () => notesApi.list("home", { q: words || undefined, limit: 60 }),
    enabled: open,
    staleTime: 30_000,
  });
  const mine = useMemo(() => (list.data?.notes ?? []).filter((n) => n.is_owner), [list.data]);
  const ids = new Set(picked.map((p) => p.id));
  const toggle = (id: string, title: string) => {
    if (ids.has(id)) onChange(picked.filter((p) => p.id !== id));
    else if (picked.length < MAX_NOTES) onChange([...picked, { id, title }]);
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add your notes"
      footer={
        <Button variant="primary" className="w-full" onClick={onClose}>
          Done{picked.length > 0 ? ` (${picked.length})` : ""}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="relative">
          <span className="sr-only">Search your notes</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} type="search" placeholder="Search your notes" className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-[16px] text-[var(--text)] focus:border-[var(--accent)] focus:outline-none" />
        </label>
        {list.isLoading ? (
          <p className="py-6 text-center text-sm text-[var(--text-muted)]">Loading your notes…</p>
        ) : list.isError ? (
          <p role="alert" className="py-6 text-center text-sm text-[var(--danger)]">
            Your notes couldn't be loaded.
          </p>
        ) : mine.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--text-muted)]">{words ? "No notes match that." : "You have no notes yet."}</p>
        ) : (
          <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
            {mine.map((n) => {
              const on = ids.has(n.id);
              const full = !on && picked.length >= MAX_NOTES;
              return (
                <li key={n.id}>
                  <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl px-2 py-2 hover:bg-[var(--hover)]", full && "cursor-not-allowed opacity-50")}>
                    <input type="checkbox" checked={on} disabled={full} onChange={() => toggle(n.id, n.title)} className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-[var(--text)]">{n.title || "Untitled note"}</span>
                      {n.snippet && <span className="line-clamp-1 text-sm text-[var(--text-muted)]">{n.snippet}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-[var(--text-muted)]">Up to {MAX_NOTES} of your own notes.</p>
      </div>
    </Sheet>
  );
}
