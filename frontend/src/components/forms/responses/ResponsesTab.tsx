import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  FileText,
  Inbox,
  Loader2,
  Map as MapIcon,
  MapPin,
  MoreHorizontal,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import {
  formsApi,
  type NotifyMode,
  type NotifySettings,
  type OneResponse,
  type Respondent,
  type ResponsesSummary,
  type SummaryQuestion,
} from "@/api/forms";
import { Menu, MenuItem, fieldCls, iconBtnCls } from "@/components/forms/builder/ui";
import { extractError } from "@/components/files/helpers";
import { ErrorState } from "@/components/shared/Callout";
import { ConfirmDoubleModal } from "@/components/shared/ConfirmDoubleModal";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { useIsMobile } from "@/hooks/useIsMobile";
import { mapsPinLink } from "@/maps/links";
import type { MapCard } from "@/maps/MapChips";
import { useMapsReady } from "@/maps/useMapsReady";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

// The map library is big: loaded only when "Show on a map" is pressed.
const MapCardModal = lazy(() => import("@/maps/MapCardModal").then((m) => ({ default: m.MapCardModal })));

import { ChoiceBars, ScaleColumns, pct, type ChoiceRow } from "./charts";
import { FileList, FileStrip } from "./Files";
import { Summarise } from "./Summarise";
import { SheetCard } from "./SheetCard";

/**
 * The form builder's Responses tab (Forms WP-F1.4): a summary per question
 * (charts for choices and scales, lists for dates and text), every answer
 * to one question, and one answer at a time (``‹ 3 of 12 ›``, swipe on a
 * phone). Download as CSV or Excel, delete an answer or all of them, and
 * choose how you hear about new ones. Refetches every 10 s while open.
 *
 * Answers are other people's words: they're shown as plain text only
 * (React escapes them; links aren't made clickable).
 */

type ViewKind = "summary" | "question" | "individual";

const TEXTY = new Set(["short_text", "paragraph"]);

export function ResponsesTab({
  fileId,
  canEdit,
  onSend,
  onCount,
  formTitle = "",
  openAnswer = null,
  openFile = null,
}: {
  fileId: string;
  canEdit: boolean;
  onSend: () => void;
  /** The total, for the tab's label. */
  onCount?: (n: number) => void;
  /** For a new sheet's name, "<Form> (Responses)". */
  formTitle?: string;
  /** Open this answer first (a link from the sheet: ``?answer=3&file=…``). */
  openAnswer?: number | null;
  /** …with this file of it picked out. */
  openFile?: string | null;
}) {
  const qc = useQueryClient();
  const isPhone = useIsMobile();
  const { data, error, isLoading } = useQuery({
    queryKey: ["form-summary", fileId],
    queryFn: () => formsApi.summary(fileId),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
  const [view, setView] = useState<ViewKind>(openAnswer ? "individual" : "summary");
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [number, setNumber] = useState<number | null>(openAnswer);
  // "3 new since you last looked": what was new when you opened the tab.
  const [newOnOpen, setNewOnOpen] = useState<number | null>(null);
  const markedRef = useRef(false);

  useEffect(() => {
    if (!data) return;
    onCount?.(data.total);
    if (markedRef.current) return;
    markedRef.current = true;
    setNewOnOpen(data.new_count);
    if (data.new_count > 0) {
      void formsApi
        .markSeen(fileId)
        .then(() => {
          qc.invalidateQueries({ queryKey: ["forms-home"] });
          qc.invalidateQueries({ queryKey: ["today"] });
        })
        .catch(() => undefined);
    }
  }, [data, fileId, onCount, qc]);

  // While the tab stays open, what arrives is seen too.
  const lastTotal = useRef<number | null>(null);
  useEffect(() => {
    if (!data) return;
    if (lastTotal.current !== null && data.total > lastTotal.current) void formsApi.markSeen(fileId).catch(() => undefined);
    lastTotal.current = data.total;
  }, [data, fileId]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-16 text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> Loading answers…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-10">
        <ErrorState>Couldn&apos;t load the answers. {extractError(error)}</ErrorState>
      </div>
    );
  }

  const openQuestion = (id: string) => {
    setQuestionId(id);
    setView("question");
  };
  const showAnswer = (n: number) => {
    setNumber(n);
    setView("individual");
  };

  return (
    <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto w-full max-w-3xl px-3 pb-16 pt-4 sm:px-4">
        <Header fileId={fileId} summary={data} newOnOpen={newOnOpen} canEdit={canEdit} />
        <SheetCard fileId={fileId} summary={data} canEdit={canEdit} formTitle={formTitle} />
        {data.total === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={<Inbox className="h-5 w-5" />}
              title="No answers yet"
              description={
                canEdit
                  ? data.accepting
                    ? "Send your form and answers show up here as they come in."
                    : "Your form isn't taking answers. Switch on “Taking answers”, then send it."
                  : "Answers show up here as they come in."
              }
              action={
                canEdit ? (
                  <button
                    type="button"
                    onClick={onSend}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
                  >
                    <Send className="h-4 w-4" aria-hidden="true" /> Send your form
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            <ViewSwitch view={view} onView={setView} />
            {view === "summary" && <SummaryView fileId={fileId} summary={data} narrow={isPhone} onQuestion={openQuestion} onAnswer={showAnswer} />}
            {view === "question" && (
              <QuestionView
                fileId={fileId}
                summary={data}
                questionId={questionId ?? data.questions[0]?.id ?? null}
                onQuestion={setQuestionId}
                onAnswer={showAnswer}
              />
            )}
            {view === "individual" && (
              <IndividualView
                fileId={fileId}
                number={number ?? data.latest_number}
                total={data.total}
                onNumber={setNumber}
                canDelete={data.can_delete}
                isPhone={isPhone}
                sheetLinked={!!data.sheet?.file_id}
                highlight={openFile}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ header

function Header({ fileId, summary, newOnOpen, canEdit }: { fileId: string; summary: ResponsesSummary; newOnOpen: number | null; canEdit: boolean }) {
  const qc = useQueryClient();
  const [deleteAll, setDeleteAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<"csv" | "xlsx" | null>(null);

  const download = async (format: "csv" | "xlsx") => {
    setDownloading(format);
    try {
      const { blob, filename } = await formsApi.exportResponses(fileId, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setDownloading(null);
    }
  };

  const removeAll = async () => {
    setBusy(true);
    try {
      const { deleted } = await formsApi.deleteAllResponses(fileId);
      toast.success(deleted === 1 ? "Deleted 1 answer" : `Deleted ${deleted} answers`);
      setDeleteAll(false);
      qc.invalidateQueries({ queryKey: ["form-summary", fileId] });
      qc.invalidateQueries({ queryKey: ["form-response", fileId] });
      qc.invalidateQueries({ queryKey: ["form-question", fileId] });
      qc.invalidateQueries({ queryKey: ["forms-home"] });
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const total = summary.total;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold text-[var(--text)]" data-testid="responses-total">
          {total === 1 ? "1 answer" : `${total.toLocaleString()} answers`}
        </h2>
        {newOnOpen !== null && newOnOpen > 0 && (
          <p className="text-xs font-medium text-[var(--accent-text)]">{newOnOpen === 1 ? "1 new since you last looked" : `${newOnOpen} new since you last looked`}</p>
        )}
      </div>
      <NotifyButton fileId={fileId} settings={summary.notify} />
      {total > 0 && (
        <Menu label="Download answers" icon={downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Download className="h-4 w-4" /><span className="hidden sm:inline">Download</span></>} buttonClassName="border border-[var(--border)]">
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); void download("xlsx"); }}>
                <FileSpreadsheet className="h-4 w-4" /> Excel (.xlsx)
              </MenuItem>
              <MenuItem onClick={() => { close(); void download("csv"); }}>
                <FileText className="h-4 w-4" /> CSV (.csv)
              </MenuItem>
            </>
          )}
        </Menu>
      )}
      {canEdit && summary.can_delete && total > 0 && (
        <Menu label="More answer actions" icon={<MoreHorizontal className="h-4 w-4" />}>
          {(close) => (
            <MenuItem danger onClick={() => { close(); setDeleteAll(true); }}>
              <Trash2 className="h-4 w-4" /> Delete all answers
            </MenuItem>
          )}
        </Menu>
      )}
      <ConfirmDoubleModal
        open={deleteAll}
        onClose={() => setDeleteAll(false)}
        onConfirm={removeAll}
        firstTitle="Delete all answers?"
        firstDescription={`All ${total === 1 ? "1 answer" : `${total} answers`} to this form will be deleted. The questions stay as they are.`}
        firstConfirmLabel="Continue"
        secondTitle="This can't be undone"
        secondDescription={`Download the answers first if you might want them later. Places on limited options open up again.${summary.sheet?.file_id ? " Deleting answers here doesn't change your sheet." : ""}`}
        secondConfirmLabel="Delete all answers"
        destructive
        pending={busy}
      />
    </div>
  );
}

const MODE_WORDS: Record<NotifyMode, { title: string; hint: string }> = {
  each: { title: "Each time", hint: "One notification that updates as answers arrive" },
  daily: { title: "Once a day", hint: "In your daily summary" },
  off: { title: "Never", hint: "You can still see them here" },
};

function NotifyButton({ fileId, settings: saved }: { fileId: string; settings: NotifySettings }) {
  const qc = useQueryClient();
  // Local, so a choice shows the moment it's made (the cache updates later).
  const [settings, setSettings] = useState(saved);
  useEffect(() => setSettings(saved), [saved]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, ref, () => setOpen(false));
  const save = async (changes: { mode?: NotifyMode; email_daily?: boolean }) => {
    setSaving(true);
    const before = settings;
    const put = (n: NotifySettings) => {
      setSettings(n);
      qc.setQueryData<ResponsesSummary>(["form-summary", fileId], (cur) => (cur ? { ...cur, notify: n } : cur));
    };
    // Shown at once; put back if it doesn't save.
    put({ ...settings, ...changes });
    try {
      put(await formsApi.setNotify(fileId, changes));
    } catch (e) {
      put(before);
      toast.error(extractError(e));
    } finally {
      setSaving(false);
    }
  };
  const off = settings.mode === "off";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={cn(iconBtnCls, "border border-[var(--border)]")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Notifications for this form"
      >
        {off ? <BellOff className="h-4 w-4" aria-hidden="true" /> : <Bell className="h-4 w-4" aria-hidden="true" />}
        <span className="hidden sm:inline">{off ? "Not notifying" : settings.mode === "daily" ? "Daily" : "Notifying"}</span>
        <span className="sr-only sm:hidden">Notifications for this form</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Notifications for this form"
          className="absolute right-0 top-10 z-40 w-[min(20rem,calc(100vw-2rem))] rounded-card border border-[var(--border)] bg-[var(--surface)] p-3 text-[var(--text)] shadow-lg"
        >
          <fieldset aria-busy={saving}>
            <legend className="mb-2 text-sm font-semibold">Tell me about new answers</legend>
            {(["each", "daily", "off"] as const).map((m) => (
              <label key={m} className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1.5 hover:bg-[var(--hover)]">
                <input
                  type="radio"
                  name={`notify-${fileId}`}
                  className="mt-0.5 accent-[var(--accent)]"
                  checked={settings.mode === m}
                  onChange={() => void save({ mode: m })}
                />
                <span>
                  <span className="block text-sm">{MODE_WORDS[m].title}</span>
                  <span className="block text-xs text-[var(--text-muted)]">{MODE_WORDS[m].hint}</span>
                </span>
              </label>
            ))}
            <label className={cn("mt-2 flex items-start gap-2 border-t border-[var(--border)] px-1 pt-2.5", settings.can_email ? "cursor-pointer" : "opacity-60")}>
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--accent)]"
                checked={settings.email_daily}
                disabled={!settings.can_email && !settings.email_daily}
                onChange={(e) => void save({ email_daily: e.target.checked })}
              />
              <span>
                <span className="block text-sm">Also email me once a day</span>
                <span className="block text-xs text-[var(--text-muted)]">
                  {settings.can_email ? "How many came in, never what they said." : "This server can't send email yet. An admin can set it up."}
                </span>
              </span>
            </label>
          </fieldset>
          <p className="mt-2 text-xs text-[var(--text-muted)]">Notifications only ever say how many answers came in.</p>
        </div>
      )}
    </div>
  );
}

function ViewSwitch({ view, onView }: { view: ViewKind; onView: (v: ViewKind) => void }) {
  const items: { key: ViewKind; label: string }[] = [
    { key: "summary", label: "Summary" },
    { key: "question", label: "Question" },
    { key: "individual", label: "Individual" },
  ];
  return (
    <div role="group" aria-label="How to show the answers" className="mt-4 inline-flex rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0.5">
      {items.map((i) => (
        <button
          key={i.key}
          type="button"
          aria-pressed={view === i.key}
          onClick={() => onView(i.key)}
          className={cn(
            "h-8 rounded-md px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
            view === i.key ? "bg-[var(--bg)] font-semibold text-[var(--text)] shadow-sm ring-1 ring-[var(--border)]" : "text-[var(--text-muted)] hover:text-[var(--text)]"
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ summary

function answeredWords(n: number): string {
  return n === 1 ? "1 answer" : `${n.toLocaleString()} answers`;
}

function Card({ q, children }: { q: SummaryQuestion; children: ReactNode }) {
  return (
    <section aria-labelledby={`sq-${q.id}`} className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      <h3 id={`sq-${q.id}`} className="break-words text-sm font-semibold text-[var(--text)]">
        {q.title}
        {q.deleted && <span className="ml-2 rounded bg-[var(--hover)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-muted)]">deleted question</span>}
      </h3>
      <p className="mb-3 mt-0.5 text-xs text-[var(--text-muted)]">{answeredWords(q.answered)}</p>
      {children}
    </section>
  );
}

function SummaryView({
  fileId,
  summary,
  narrow,
  onQuestion,
  onAnswer,
}: {
  fileId: string;
  summary: ResponsesSummary;
  narrow: boolean;
  onQuestion: (id: string) => void;
  onAnswer: (n: number) => void;
}) {
  return (
    <div className="mt-4 space-y-3" data-testid="responses-summary">
      {summary.questions.map((q) => (
        <Card key={q.id} q={q}>
          {q.answered === 0 ? <p className="text-sm text-[var(--text-muted)]">No answers to this question yet.</p> : <QuestionSummary fileId={fileId} q={q} narrow={narrow} onQuestion={onQuestion} onAnswer={onAnswer} />}
          {TEXTY.has(q.kind) && <Summarise fileId={fileId} questionId={q.id} answered={q.answered} onAnswer={onAnswer} />}
        </Card>
      ))}
    </div>
  );
}

function SrTable({ caption, rows }: { caption: string; rows: [string, string][] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <tbody>
        {rows.map(([a, b], i) => (
          <tr key={i}>
            <th scope="row">{a}</th>
            <td>{b}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A grid's summary: a small group of bars per row (one bar per column,
 *  percentages of the people who answered that row), with the same numbers
 *  in a real table for screen readers. */
function GridSummary({ q, narrow }: { q: SummaryQuestion; narrow: boolean }) {
  const rows = q.rows ?? [];
  const cols = q.columns ?? [];
  const multi = q.kind === "checkbox_grid";
  return (
    <>
      <div className="space-y-3" aria-hidden="true">
        {rows.map((r) => (
          <div key={r.id}>
            <p className="mb-0.5 break-words text-xs font-medium text-[var(--text)]">
              {r.label} <span className="font-normal text-[var(--text-muted)]">· {answeredWords(r.answered)}</span>
            </p>
            <ChoiceBars rows={cols.map((c) => ({ key: c.id, label: c.label, count: r.counts[c.id] ?? 0 }))} of={r.answered} narrow={narrow} />
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>{`${q.title}: answers per row and column`}</caption>
        <thead>
          <tr>
            <td />
            {cols.map((c) => (
              <th key={c.id} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">{`${r.label} (${answeredWords(r.answered)})`}</th>
              {cols.map((c) => (
                <td key={c.id}>{`${r.counts[c.id] ?? 0}, ${pct(r.counts[c.id] ?? 0, r.answered)}`}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {multi && <p className="mt-1 text-xs text-[var(--text-muted)]">People could tick more than one per row, so a row can add up to more than 100%.</p>}
    </>
  );
}

/** A Location question's summary: the newest places (a pin when one was
 *  picked from the suggestions, with "Open in P Maps"), and "Show on a
 *  map" for all of them when this server has Maps. */
function PlacesSummary({ fileId, q, onQuestion, onAnswer }: { fileId: string; q: SummaryQuestion; onQuestion: (id: string) => void; onAnswer: (n: number) => void }) {
  const maps = useMapsReady();
  const [card, setCard] = useState<MapCard | null>(null);
  const [loading, setLoading] = useState(false);
  const showMap = async () => {
    setLoading(true);
    try {
      const { places, capped } = await formsApi.places(fileId, q.id);
      if (!places.length) {
        toast.info("None of these answers has a spot on the map yet.");
        return;
      }
      if (capped) toast.info("Showing the newest 2,000 places.");
      setCard({
        kind: "places",
        title: q.title,
        places: places.map((p) => ({ lat: p.lat!, lon: p.lon!, name: `#${p.number}: ${p.text}`.slice(0, 120) })),
      });
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setLoading(false);
    }
  };
  const list = q.places ?? [];
  return (
    <>
      <ul className="divide-y divide-[var(--border)]">
        {list.map((p) => (
          <li key={p.number} className="flex items-center gap-2 py-1.5 text-sm">
            {p.lat !== undefined ? (
              <MapPin className="h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-label="On the map" />
            ) : (
              <span className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <button type="button" onClick={() => onAnswer(p.number)} className="min-w-0 flex-1 truncate text-left text-[var(--text)] hover:underline" title={`Open answer #${p.number}`}>
              {p.text}
            </button>
            {maps && p.lat !== undefined && p.lon !== undefined && (
              <Link to={mapsPinLink(p.lat, p.lon, p.text.slice(0, 80))} className="shrink-0 text-xs font-medium text-[var(--accent-text)] hover:underline">
                Open in P Maps
              </Link>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {q.answered > list.length && (
          <button type="button" onClick={() => onQuestion(q.id)} className="text-sm font-medium text-[var(--accent-text)] hover:underline">
            Show all {q.answered.toLocaleString()}
          </button>
        )}
        {maps && !!q.with_spot && (
          <button
            type="button"
            onClick={() => void showMap()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--accent-text)] hover:underline disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <MapIcon className="h-4 w-4" aria-hidden="true" />} Show on a map
          </button>
        )}
        <span className="text-xs text-[var(--text-muted)]">
          {q.with_spot === 1 ? "1 place is on the map" : `${(q.with_spot ?? 0).toLocaleString()} places are on the map`}; typed ones have no spot.
        </span>
      </div>
      {card && (
        <Suspense fallback={null}>
          <MapCardModal card={card} onClose={() => setCard(null)} />
        </Suspense>
      )}
    </>
  );
}

function QuestionSummary({ fileId, q, narrow, onQuestion, onAnswer }: { fileId: string; q: SummaryQuestion; narrow: boolean; onQuestion: (id: string) => void; onAnswer: (n: number) => void }) {
  if (q.rows && q.columns) return <GridSummary q={q} narrow={narrow} />;
  if (q.places) return <PlacesSummary fileId={fileId} q={q} onQuestion={onQuestion} onAnswer={onAnswer} />;
  if (q.options) {
    const rows: ChoiceRow[] = q.options.map((o) => ({
      key: o.id,
      label: o.label,
      count: o.count,
      note: o.limit ? `${o.taken ?? o.count}/${o.limit}${(o.taken ?? o.count) >= o.limit ? " (full)" : ""}` : undefined,
    }));
    if (q.other !== null && q.other !== undefined) rows.push({ key: "__other", label: "Other", count: q.other, muted: true });
    return (
      <>
        <ChoiceBars rows={rows} of={q.answered} narrow={narrow} />
        <SrTable caption={`${q.title}: answers per option`} rows={rows.map((r) => [r.note ? `${r.label} (${r.note})` : r.label, `${r.count}, ${pct(r.count, q.answered)}`])} />
        {q.kind === "checkboxes" && <p className="mt-1 text-xs text-[var(--text-muted)]">People could tick more than one, so this adds up to more than 100%.</p>}
        {!!q.other && (
          <button type="button" onClick={() => onQuestion(q.id)} className="mt-2 text-sm font-medium text-[var(--accent-text)] hover:underline">
            See what “Other” says
          </button>
        )}
      </>
    );
  }
  if (q.bins) {
    return (
      <>
        <p className="text-sm text-[var(--text)]">
          Average <span className="font-semibold tabular-nums">{q.average ?? "–"}</span>
          {q.kind === "rating" && q.bins.length ? <span className="text-[var(--text-muted)]"> out of {q.bins[q.bins.length - 1].value}</span> : null}
        </p>
        <ScaleColumns bins={q.bins} of={q.answered} />
        {(q.min_label || q.max_label) && (
          <div className="flex justify-between text-xs text-[var(--text-muted)]">
            <span>{q.min_label ? `${q.bins[0]?.value}: ${q.min_label}` : ""}</span>
            <span>{q.max_label ? `${q.bins[q.bins.length - 1]?.value}: ${q.max_label}` : ""}</span>
          </div>
        )}
        <SrTable caption={`${q.title}: answers per value`} rows={q.bins.map((b) => [String(b.value), `${b.count}, ${pct(b.count, q.answered)}`])} />
      </>
    );
  }
  if (q.groups) {
    return (
      <>
        <ul className="divide-y divide-[var(--border)]">
          {q.groups.map((g) => (
            <li key={g.value} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
              <span className="text-[var(--text)]">{q.kind === "date" ? dayWords(g.value) : g.value}</span>
              <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{g.count}</span>
            </li>
          ))}
        </ul>
        {!!q.more_groups && (
          <button type="button" onClick={() => onQuestion(q.id)} className="mt-2 text-sm font-medium text-[var(--accent-text)] hover:underline">
            And {q.more_groups} more: see every answer
          </button>
        )}
      </>
    );
  }
  if (q.files) {
    return <FileStrip files={q.files} answered={q.answered} onAnswer={onAnswer} onQuestion={() => onQuestion(q.id)} />;
  }
  if (q.latest) {
    return (
      <>
        <ul className="space-y-1.5">
          {q.latest.map((t) => (
            <li key={t.number}>
              <button
                type="button"
                onClick={() => onAnswer(t.number)}
                className="block w-full rounded-md bg-[var(--bg)] px-3 py-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                title={`Open answer #${t.number}`}
              >
                <span className="line-clamp-3 whitespace-pre-wrap break-words">{t.text}</span>
              </button>
            </li>
          ))}
        </ul>
        {q.answered > q.latest.length && (
          <button type="button" onClick={() => onQuestion(q.id)} className="mt-2 text-sm font-medium text-[var(--accent-text)] hover:underline">
            Show all {q.answered.toLocaleString()}
          </button>
        )}
      </>
    );
  }
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat 5 Dec 2026" for 2026-12-05; "5 Dec" for 12-05 (no year). */
function dayWords(v: string): string {
  const full = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (full) {
    const d = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]));
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  const md = v.match(/^(\d{2})-(\d{2})$/);
  if (md) return `${Number(md[2])} ${MONTHS[Number(md[1]) - 1] ?? md[1]}`;
  return v;
}

function whenWords(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric", hour: "numeric", minute: "2-digit" });
}

function WhoLine({ who }: { who: Respondent }) {
  return (
    <span>
      {who.name}
      {who.kind === "email" && <span className="text-[var(--text-muted)]"> (typed, not checked)</span>}
    </span>
  );
}

// ------------------------------------------------------------------ one question

function QuestionView({
  fileId,
  summary,
  questionId,
  onQuestion,
  onAnswer,
}: {
  fileId: string;
  summary: ResponsesSummary;
  questionId: string | null;
  onQuestion: (id: string) => void;
  onAnswer: (n: number) => void;
}) {
  const q = summary.questions.find((x) => x.id === questionId) ?? summary.questions[0];
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);
  useEffect(() => {
    setTyped("");
    setSearch("");
  }, [questionId]);
  const searchable = !!q && (TEXTY.has(q.kind) || q.kind === "location" || (q.other !== undefined && q.other !== null));
  const query = useInfiniteQuery({
    queryKey: ["form-question", fileId, q?.id, search, summary.total],
    queryFn: ({ pageParam }) => formsApi.questionAnswers(fileId, q!.id, { before: pageParam, q: search }),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before,
    enabled: !!q,
  });
  if (!q) return null;
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--text-muted)]">
          Question
          <select className={fieldCls} value={q.id} onChange={(e) => onQuestion(e.target.value)}>
            {summary.questions.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
                {x.deleted ? " (deleted question)" : ""} · {answeredWords(x.answered)}
              </option>
            ))}
          </select>
        </label>
        {searchable && (
          <label className="relative flex flex-col gap-1 text-xs text-[var(--text-muted)] sm:w-64">
            {TEXTY.has(q.kind) || q.kind === "location" ? "Search these answers" : "Search “Other”"}
            <Search className="pointer-events-none absolute bottom-2.5 left-2.5 h-4 w-4" aria-hidden="true" />
            <input type="search" className={cn(fieldCls, "pl-8")} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search" />
          </label>
        )}
      </div>
      {query.isLoading ? (
        <p className="py-6 text-center text-sm text-[var(--text-muted)]">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
        </p>
      ) : query.error ? (
        <ErrorState>Couldn&apos;t load these answers. {extractError(query.error)}</ErrorState>
      ) : items.length === 0 ? (
        <p className="rounded-card border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
          {search ? `Nothing matches “${search}”.` : "No answers to this question yet."}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="question-answers">
          {items.map((i) => (
            <li key={i.number} className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
              {i.files ? (
                <FileList fileId={fileId} files={i.files} />
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm text-[var(--text)]">{i.text || <span className="text-[var(--text-muted)]">No answer</span>}</p>
              )}
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--text-muted)]">
                <button type="button" onClick={() => onAnswer(i.number)} className="font-medium text-[var(--accent-text)] hover:underline">
                  #{i.number}
                </button>
                <WhoLine who={i.who} />
                <span>{whenWords(i.submitted_at)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <button
          type="button"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="w-full rounded-md border border-[var(--border)] py-2 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-60"
        >
          {query.isFetchingNextPage ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ one answer

function IndividualView({
  fileId,
  number,
  total,
  onNumber,
  canDelete,
  isPhone,
  sheetLinked,
  highlight = null,
}: {
  fileId: string;
  number: number | null;
  /** The form's answer count: when it changes, "3 of 12" is read again. */
  total: number;
  onNumber: (n: number) => void;
  canDelete: boolean;
  isPhone: boolean;
  /** A sheet is linked: say that deleting here leaves it alone. */
  sheetLinked: boolean;
  /** A file to pick out (opened from the sheet). */
  highlight?: string | null;
}) {
  const qc = useQueryClient();
  // Opened at one file (from the sheet): bring it into view once it's there.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!highlight || scrolled.current) return;
    const t = window.setInterval(() => {
      const el = document.getElementById(`form-file-${highlight}`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        scrolled.current = true;
        window.clearInterval(t);
      }
    }, 200);
    const stop = window.setTimeout(() => window.clearInterval(t), 5000);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(stop);
    };
  }, [highlight]);
  const { data, error, isLoading } = useQuery({
    queryKey: ["form-response", fileId, number, total],
    queryFn: () => formsApi.response(fileId, number!),
    enabled: number !== null,
    placeholderData: (prev) => prev,
    retry: false,
  });
  const [deleting, setDeleting] = useState(false);
  const touch = useRef<{ x: number; y: number } | null>(null);

  const go = (n: number | null | undefined) => {
    if (n) onNumber(n);
  };

  const remove = async (r: OneResponse) => {
    const ok = await confirm({
      title: `Delete answer #${r.number}?`,
      message: `It's deleted for good. If it took a place on a limited option, that place opens up again.${sheetLinked ? " Deleting an answer here doesn't change your sheet." : ""}`,
      confirmLabel: "Delete answer",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await formsApi.deleteResponse(fileId, r.number);
      toast.success(`Deleted answer #${r.number}`);
      const next = r.next ?? r.prev;
      // Every cached answer's "3 of 12" is out of date now.
      qc.removeQueries({ queryKey: ["form-response", fileId] });
      await qc.invalidateQueries({ queryKey: ["form-summary", fileId] });
      qc.invalidateQueries({ queryKey: ["form-question", fileId] });
      qc.invalidateQueries({ queryKey: ["forms-home"] });
      if (next) onNumber(next);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setDeleting(false);
    }
  };

  const nav = data;

  if (number === null) return null;
  if (isLoading && !data) {
    return (
      <p className="mt-6 text-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
      </p>
    );
  }
  if (error || !nav) {
    return (
      <div className="mt-4">
        <ErrorState>That answer isn&apos;t here any more. It may have been deleted.</ErrorState>
      </div>
    );
  }
  const r = nav;
  const navBtn = "inline-flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40";
  return (
    <div
      className="mt-4"
      onKeyDown={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (e.key === "ArrowLeft") go(r.prev);
        if (e.key === "ArrowRight") go(r.next);
      }}
      onTouchStart={(e) => {
        touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={(e) => {
        const start = touch.current;
        touch.current = null;
        if (!start) return;
        const dx = e.changedTouches[0].clientX - start.x;
        const dy = e.changedTouches[0].clientY - start.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? r.next : r.prev);
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <button type="button" className={navBtn} onClick={() => go(r.prev)} disabled={!r.prev} aria-label="Previous answer">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <p className="text-sm font-medium tabular-nums text-[var(--text)]" aria-live="polite" data-testid="individual-position">
          {r.position} of {r.total}
        </p>
        <button type="button" className={navBtn} onClick={() => go(r.next)} disabled={!r.next} aria-label="Next answer">
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      <article className="mt-3 rounded-card border border-[var(--border)] bg-[var(--surface)]" aria-label={`Answer #${r.number}`}>
        <header className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-semibold text-[var(--text)]">
              <WhoLine who={r.who} />
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              #{r.number} · {whenWords(r.submitted_at)}
              {r.edited_at ? ` · changed ${whenWords(r.edited_at)}` : ""}
            </p>
          </div>
          {canDelete && (
            <button
              type="button"
              onClick={() => void remove(r)}
              disabled={deleting}
              className="inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-sm text-red-600 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50 dark:text-red-400"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" /> {isPhone ? "Delete" : "Delete this answer"}
            </button>
          )}
        </header>
        <dl className="divide-y divide-[var(--border)]">
          {r.answers.map((a) => (
            <div key={a.id} className="px-4 py-3">
              <dt className="break-words text-xs font-medium text-[var(--text-muted)]">
                {a.title}
                {a.deleted ? " (deleted question)" : ""}
              </dt>
              <dd className={cn("mt-0.5 whitespace-pre-wrap break-words text-sm", a.answered ? "text-[var(--text)]" : "italic text-[var(--text-muted)]")}>
                {a.answered && a.files ? <FileList fileId={fileId} files={a.files} highlight={highlight} /> : a.answered ? a.text : "No answer"}
              </dd>
            </div>
          ))}
        </dl>
      </article>
      {isPhone && <p className="mt-2 text-center text-xs text-[var(--text-muted)]">Swipe left or right for the next answer.</p>}
    </div>
  );
}
