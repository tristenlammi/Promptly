import { Heart, MoreHorizontal, Star, ThumbsUp, Upload } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import type {
  CheckboxesConfig,
  ChoiceGridConfig,
  DateConfig,
  DropdownConfig,
  FileUploadConfig,
  FormDefinition,
  FormItem,
  FormOption,
  LinearScaleConfig,
  MultipleChoiceConfig,
  ParagraphConfig,
  RatingConfig,
  ShortTextConfig,
  TimeConfig,
} from "@/api/forms";
import { cn } from "@/utils/cn";

import "./forms.css";
import { HeaderArt, isBuiltinHeader } from "./headers";
import {
  isEmpty,
  nextSection,
  sectionProblems,
  shuffled,
  type AnswerValue,
  type Answers,
  type CheckboxAnswer,
  type ChoiceAnswer,
  type GridAnswer,
} from "./logic";
import { isQuestion, sectionsOf } from "./model";
import { themeVars } from "./theme";

/**
 * One form, as the people answering it see it. The builder's preview and
 * the answer page (``/f/:token``) both render this, so they can't drift
 * apart: the header picture or accent band, the title and description,
 * "Page 2 of 3", one card per question, inline errors, and Back / Next /
 * Submit. It walks the sections the way the answers lead (branching), and
 * checks each page before moving on.
 *
 * It holds the answers and the page; the caller decides what a submit
 * does (the preview shows its confirmation; the answer page sends it).
 * Phone first: 16px gutters, 44px targets, a sticky button bar.
 */
export interface FormRendererProps {
  definition: FormDefinition;
  /** Signed links to the form's pictures, by asset id. */
  assetUrls: Record<string, string>;
  mode: "preview" | "answer";
  /** Light or dark: follow the app, the device, or fixed. */
  scheme?: "app" | "device" | "light" | "dark";
  /** Places left per option (limited options), by question id. Full ones
   *  are hidden; with ``showRemaining`` the rest say "2 left". */
  remaining?: Record<string, Record<string, number>>;
  showRemaining?: boolean;
  initialAnswers?: Answers;
  onAnswersChange?: (answers: Answers) => void;
  /** The slim line under the title ("Answering as Sam", a preview note). */
  notice?: ReactNode;
  onSubmit: (answers: Answers, path: number[], email?: string) => void | Promise<void>;
  submitting?: boolean;
  submitError?: string | null;
  /** The Submit button's words ("Save changes" when changing an answer). */
  submitLabel?: string;
  /** Ask for an email address on the first page (link forms that collect one). */
  askEmail?: boolean;
  initialEmail?: string;
  onEmailChange?: (email: string) => void;
  /** Problems the server found, by question id ("_email" for the email box). */
  fieldErrors?: Record<string, string> | null;
  /** The file question's control (the answer page's uploader). */
  renderUpload?: (item: FormItem<"file_upload">, value: string[], onChange: (ids: string[]) => void) => ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function FormRenderer({
  definition,
  assetUrls,
  mode,
  scheme = "app",
  remaining,
  showRemaining,
  initialAnswers,
  onAnswersChange,
  notice,
  onSubmit,
  submitting,
  submitError,
  submitLabel = "Submit",
  askEmail,
  initialEmail,
  onEmailChange,
  fieldErrors,
  renderUpload,
  footer,
  className,
}: FormRendererProps) {
  const sections = useMemo(() => sectionsOf(definition), [definition]);
  const [answers, setAnswers] = useState<Answers>(initialAnswers ?? {});
  const [path, setPath] = useState<number[]>([0]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announce, setAnnounce] = useState("");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [seed] = useState(() => Math.floor(Math.random() * 1e9));
  const top = useRef<HTMLDivElement>(null);
  const formId = useId();

  // The definition can change under a preview: keep the page in range.
  const current = Math.min(path[path.length - 1] ?? 0, sections.length - 1);
  const section = sections[current];
  const next = nextSection(sections, current, answers);
  const isLast = next === "submit";

  const set = (id: string, v: AnswerValue | undefined) => {
    setAnswers((prev) => {
      const out = { ...prev, [id]: v };
      if (v === undefined) delete out[id];
      onAnswersChange?.(out);
      return out;
    });
    if (errors[id]) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== id)));
  };

  const scrollTop = () => top.current?.scrollIntoView({ block: "start", behavior: "smooth" });

  const showProblems = (probs: Record<string, string>) => {
    const ids = Object.keys(probs);
    const n = ids.length;
    setAnnounce(n === 1 ? "One question needs attention." : `${n} questions need attention.`);
    window.setTimeout(() => {
      const el = document.getElementById(`${formId}-${ids[0]}`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      const field = el?.querySelector<HTMLElement>("input, textarea, select, button");
      field?.focus({ preventScroll: true });
    }, 30);
  };

  const check = (): boolean => {
    const probs = sectionProblems(section, answers);
    if (askEmail && current === 0) {
      const e = emailProblem(email);
      if (e) probs[EMAIL_ID] = e;
    }
    setErrors(probs);
    if (Object.keys(probs).length) {
      showProblems(probs);
      return false;
    }
    setAnnounce("");
    return true;
  };

  // Problems the server found (a place just taken, a check it made): shown
  // under their question when it's on this page.
  useEffect(() => {
    if (!fieldErrors || !Object.keys(fieldErrors).length) return;
    const here = Object.fromEntries(
      Object.entries(fieldErrors).filter(
        ([id]) => (id === EMAIL_ID && askEmail && current === 0) || section.items.some((q) => q.id === id)
      )
    );
    if (!Object.keys(here).length) return;
    setErrors((e) => ({ ...e, ...here }));
    showProblems(here);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldErrors]);

  const goNext = () => {
    if (!check()) return;
    if (next === "submit") return;
    setPath((p) => [...p, next]);
    scrollTop();
  };
  const goBack = () => {
    setErrors({});
    setPath((p) => (p.length > 1 ? p.slice(0, -1) : p));
    scrollTop();
  };
  const submit = () => {
    if (!check()) return;
    void onSubmit(answers, path.map((i) => Math.min(i, sections.length - 1)), askEmail ? email.trim() : undefined);
  };
  const clear = () => {
    setAnswers({});
    onAnswersChange?.({});
    setErrors({});
    setPath([0]);
    scrollTop();
  };

  const remainingFor = (q: FormItem): Record<string, number> | undefined => {
    if (remaining?.[q.id]) return remaining[q.id];
    if (mode !== "preview") return undefined;
    // Preview: nobody has answered, so every limited option has all its places.
    const opts = (q.config as { options?: FormOption[] }).options ?? [];
    const out: Record<string, number> = {};
    for (const o of opts) if (o.limit) out[o.id] = o.limit;
    return out;
  };

  return (
    <div
      className={cn("pf-theme min-h-full", className)}
      data-scheme={scheme}
      style={themeVars(definition.theme?.accent, definition.theme?.font)}
    >
      <div ref={top} className="mx-auto flex w-full max-w-[42rem] flex-col gap-3 px-4 pb-4 pt-4 sm:pt-6">
        <FormHeader definition={definition} assetUrls={assetUrls} />
        <div className="pf-card overflow-hidden">
          <div className="h-2" style={{ background: "var(--pf-accent)" }} />
          <div className="flex flex-col gap-2 px-4 py-4 sm:px-6">
            <h1 className="text-2xl font-semibold leading-tight [overflow-wrap:anywhere]">
              {definition.title || "Untitled form"}
            </h1>
            {definition.description && (
              <p className="whitespace-pre-line text-[15px] leading-relaxed">
                <Linkified text={definition.description} />
              </p>
            )}
            {notice && <div className="border-t pt-2 text-sm" style={{ borderColor: "var(--pf-border)", color: "var(--pf-muted)" }}>{notice}</div>}
            <p className="text-sm" style={{ color: "var(--pf-error)" }}>
              <span aria-hidden="true">*</span> Required
            </p>
          </div>
        </div>

        {sections.length > 1 && (
          <div className="flex flex-col gap-1.5 px-1">
            <p className="text-sm font-medium" style={{ color: "var(--pf-muted)" }}>
              Page {current + 1} of {sections.length}
            </p>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ background: "var(--pf-border)" }}
              role="progressbar"
              aria-label="Progress"
              aria-valuemin={1}
              aria-valuemax={sections.length}
              aria-valuenow={current + 1}
            >
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${((current + 1) / sections.length) * 100}%`, background: "var(--pf-accent)" }}
              />
            </div>
          </div>
        )}

        {section.item && (
          <div className="pf-card overflow-hidden">
            <div className="px-4 py-3 text-sm font-semibold sm:px-6" style={{ background: "var(--pf-accent)", color: "var(--pf-on-accent)" }}>
              Section {current + 1} of {sections.length}
            </div>
            <div className="flex flex-col gap-1 px-4 py-3 sm:px-6">
              <h2 className="text-xl font-semibold [overflow-wrap:anywhere]">{section.item.title || "Untitled section"}</h2>
              {section.item.description && (
                <p className="whitespace-pre-line text-[15px]">
                  <Linkified text={section.item.description} />
                </p>
              )}
            </div>
          </div>
        )}

        <div className="sr-only" role="status" aria-live="assertive">
          {announce}
        </div>

        {askEmail && current === 0 && (
          <EmailCard
            domId={`${formId}-${EMAIL_ID}`}
            value={email}
            error={errors[EMAIL_ID]}
            onChange={(v) => {
              setEmail(v);
              onEmailChange?.(v);
              if (errors[EMAIL_ID]) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== EMAIL_ID)));
            }}
          />
        )}

        {section.items.length === 0 && !section.item && (
          <div className="pf-card px-4 py-6 text-center text-sm sm:px-6" style={{ color: "var(--pf-muted)" }}>
            {mode === "preview" ? "Add a question and it shows here." : "There's nothing to fill in on this page."}
          </div>
        )}

        {section.items.map((item) => (
          <Fragment key={item.id}>
            {isQuestion(item) ? (
              <QuestionCard
                domId={`${formId}-${item.id}`}
                item={item}
                value={answers[item.id]}
                error={errors[item.id]}
                onChange={(v) => set(item.id, v)}
                assetUrls={assetUrls}
                mode={mode}
                seed={seed}
                remaining={remainingFor(item)}
                showRemaining={!!showRemaining}
                renderUpload={renderUpload}
              />
            ) : (
              <BlockCard item={item} assetUrls={assetUrls} />
            )}
          </Fragment>
        ))}

        {submitError && (
          <p role="alert" className="rounded-xl px-4 py-3 text-sm" style={{ background: "var(--pf-error-bg)", color: "var(--pf-error)" }}>
            {submitError}
          </p>
        )}
      </div>

      <div
        className="sticky bottom-0 z-10 border-t pb-safe"
        style={{ background: "color-mix(in srgb, var(--pf-bg) 92%, transparent)", borderColor: "var(--pf-border)", backdropFilter: "blur(6px)" }}
      >
        <div className="mx-auto flex w-full max-w-[42rem] items-center gap-2 px-4 py-2">
          {path.length > 1 && (
            <button type="button" className="pf-btn pf-btn-ghost" onClick={goBack}>
              Back
            </button>
          )}
          <span className="flex-1" />
          <ClearMenu onClear={clear} disabled={Object.keys(answers).length === 0} />
          {isLast ? (
            <button type="button" className="pf-btn pf-btn-primary" onClick={submit} disabled={submitting}>
              {submitting ? "Sending…" : submitLabel}
            </button>
          ) : (
            <button type="button" className="pf-btn pf-btn-primary" onClick={goNext}>
              Next
            </button>
          )}
        </div>
      </div>
      {footer && <div className="mx-auto w-full max-w-[42rem] px-4 pb-6 pt-2 text-center text-xs" style={{ color: "var(--pf-muted)" }}>{footer}</div>}
    </div>
  );
}

const EMAIL_ID = "_email";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailProblem(v: string): string | null {
  const s = v.trim();
  if (!s) return "Enter your email address.";
  return s.length > 254 || !EMAIL_RE.test(s) ? "Enter an email like name@example.com." : null;
}

/** "Your email" on a link form that asks for one (typed, not checked). */
function EmailCard({
  domId,
  value,
  error,
  onChange,
}: {
  domId: string;
  value: string;
  error?: string;
  onChange: (v: string) => void;
}) {
  const errId = `${domId}-err`;
  return (
    <div id={domId} className="pf-card px-4 py-4 sm:px-6" style={error ? { borderColor: "var(--pf-error)" } : undefined}>
      <div className="flex flex-col gap-3">
        <label htmlFor={`${domId}-field`} className="text-[17px] font-medium leading-snug">
          Your email
          <span style={{ color: "var(--pf-error)" }}>
            {" "}
            <span aria-hidden="true">*</span>
            <span className="sr-only">(required)</span>
          </span>
        </label>
        <input
          id={`${domId}-field`}
          className="pf-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          maxLength={254}
          placeholder="name@example.com"
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errId : undefined}
          aria-required
          onChange={(e) => onChange(e.target.value)}
        />
        {error && (
          <p id={errId} className="flex items-center gap-1.5 text-sm font-medium" style={{ color: "var(--pf-error)" }}>
            <span aria-hidden="true">!</span> {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** The header picture: one of yours, a built-in one, or a band of the accent. */
export function FormHeader({ definition, assetUrls }: { definition: FormDefinition; assetUrls: Record<string, string> }) {
  const theme = definition.theme;
  const url = theme?.header_asset_id ? assetUrls[theme.header_asset_id] : undefined;
  if (url)
    return (
      <div className="overflow-hidden rounded-[14px]" style={{ aspectRatio: "4 / 1" }}>
        <img src={url} alt="" className="h-full w-full object-cover" />
      </div>
    );
  if (isBuiltinHeader(theme?.header_builtin))
    return (
      <div className="overflow-hidden rounded-[14px]" style={{ aspectRatio: "4 / 1" }}>
        <HeaderArt id={theme.header_builtin} className="h-full w-full" />
      </div>
    );
  return <div className="h-3 rounded-full sm:h-4" style={{ background: "var(--pf-band)" }} aria-hidden="true" />;
}

/** The confirmation after sending, in the form's look. */
export function FormDone({
  definition,
  assetUrls,
  scheme = "app",
  message,
  children,
}: {
  definition: FormDefinition;
  assetUrls: Record<string, string>;
  scheme?: FormRendererProps["scheme"];
  message: string;
  children?: ReactNode;
}) {
  return (
    <div className="pf-theme min-h-full" data-scheme={scheme} style={themeVars(definition.theme?.accent, definition.theme?.font)}>
      <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-3 px-4 py-4 sm:py-6">
        <FormHeader definition={definition} assetUrls={assetUrls} />
        <div className="pf-card overflow-hidden">
          <div className="h-2" style={{ background: "var(--pf-accent)" }} />
          <div className="flex flex-col gap-3 px-4 py-5 sm:px-6">
            <h1 className="text-2xl font-semibold [overflow-wrap:anywhere]">{definition.title || "Untitled form"}</h1>
            <p className="whitespace-pre-line text-[15px]" role="status">
              <Linkified text={message || "Your answer has been sent."} />
            </p>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Plain text with web links made clickable (and nothing else interpreted). */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow" className="pf-link">
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        )
      )}
    </>
  );
}

function ClearMenu({ onClear, disabled }: { onClear: () => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirm(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setConfirm(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="pf-btn pf-btn-ghost !px-3"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
      {open && (
        <div
          role="menu"
          className="pf-card absolute bottom-12 right-0 z-20 w-56 p-1 shadow-lg"
          style={{ background: "var(--pf-card)" }}
        >
          {confirm ? (
            <div className="flex flex-col gap-2 p-2 text-sm">
              <p>Clear all your answers?</p>
              <div className="flex justify-end gap-1">
                <button type="button" className="pf-btn pf-btn-ghost !min-h-[36px] !px-3 !text-sm" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="pf-btn pf-btn-primary !min-h-[36px] !px-3 !text-sm"
                  onClick={() => {
                    onClear();
                    setOpen(false);
                    setConfirm(false);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              className="flex min-h-[44px] w-full items-center rounded-lg px-3 text-left text-sm hover:bg-[var(--pf-hover)] disabled:opacity-50"
              onClick={() => setConfirm(true)}
            >
              Clear form
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------

function BlockCard({ item, assetUrls }: { item: FormItem; assetUrls: Record<string, string> }) {
  if (item.kind === "image") {
    const url = item.image_asset_id ? assetUrls[item.image_asset_id] : undefined;
    const alt = (item.config as { alt?: string }).alt || "";
    return (
      <figure className="pf-card overflow-hidden">
        {url && <img src={url} alt={alt} className="max-h-[28rem] w-full object-contain" style={{ background: "var(--pf-hover)" }} />}
        {(item.title || item.description) && (
          <figcaption className="flex flex-col gap-1 px-4 py-3 sm:px-6">
            {item.title && <span className="font-semibold [overflow-wrap:anywhere]">{item.title}</span>}
            {item.description && (
              <span className="whitespace-pre-line text-sm" style={{ color: "var(--pf-muted)" }}>
                <Linkified text={item.description} />
              </span>
            )}
          </figcaption>
        )}
      </figure>
    );
  }
  const url = item.image_asset_id ? assetUrls[item.image_asset_id] : undefined;
  return (
    <div className="pf-card flex flex-col gap-1.5 px-4 py-4 sm:px-6">
      {item.title && <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{item.title}</h2>}
      {item.description && (
        <p className="whitespace-pre-line text-[15px]">
          <Linkified text={item.description} />
        </p>
      )}
      {url && <img src={url} alt="" className="mt-1 max-h-80 w-full rounded-lg object-contain" />}
    </div>
  );
}

interface QuestionProps {
  domId: string;
  item: FormItem;
  value: AnswerValue | undefined;
  error?: string;
  onChange: (v: AnswerValue | undefined) => void;
  assetUrls: Record<string, string>;
  mode: "preview" | "answer";
  seed: number;
  remaining?: Record<string, number>;
  showRemaining: boolean;
  renderUpload?: FormRendererProps["renderUpload"];
}

function QuestionCard(p: QuestionProps) {
  const { domId, item, error, assetUrls } = p;
  const errId = `${domId}-err`;
  const descId = `${domId}-desc`;
  const img = item.image_asset_id ? assetUrls[item.image_asset_id] : undefined;
  const described = [item.description ? descId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  // Single-field kinds label their field; the rest are a fieldset.
  const single = ["short_text", "paragraph", "dropdown", "date", "time"].includes(item.kind);
  const titleNode = (
    <>
      <span className="[overflow-wrap:anywhere]">{item.title || "Untitled question"}</span>
      {item.required && (
        <span style={{ color: "var(--pf-error)" }}>
          {" "}
          <span aria-hidden="true">*</span>
          <span className="sr-only">(required)</span>
        </span>
      )}
    </>
  );
  const body = (
    <>
      {item.description && (
        <p id={descId} className="whitespace-pre-line text-sm" style={{ color: "var(--pf-muted)" }}>
          <Linkified text={item.description} />
        </p>
      )}
      {img && <img src={img} alt="" className="max-h-80 w-full rounded-lg object-contain" />}
      <Control {...p} describedBy={described} labelId={`${domId}-label`} />
      {error && (
        <p id={errId} className="flex items-center gap-1.5 text-sm font-medium" style={{ color: "var(--pf-error)" }}>
          <span aria-hidden="true">!</span> {error}
        </p>
      )}
    </>
  );
  return (
    <div
      id={domId}
      className="pf-card px-4 py-4 sm:px-6"
      style={error ? { borderColor: "var(--pf-error)" } : undefined}
      data-question={item.id}
    >
      {single ? (
        <div className="flex flex-col gap-3">
          <label id={`${domId}-label`} htmlFor={`${domId}-field`} className="text-[17px] font-medium leading-snug">
            {titleNode}
          </label>
          {body}
        </div>
      ) : (
        <fieldset className="flex min-w-0 flex-col gap-3" aria-describedby={described}>
          <legend id={`${domId}-label`} className="mb-3 text-[17px] font-medium leading-snug">
            {titleNode}
          </legend>
          {body}
        </fieldset>
      )}
    </div>
  );
}

function Control(p: QuestionProps & { describedBy?: string; labelId: string }) {
  const { item, value, onChange, error, domId, describedBy } = p;
  const fieldProps = {
    id: `${domId}-field`,
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": describedBy,
    "aria-required": item.required || undefined,
  };
  switch (item.kind) {
    case "short_text": {
      const cfg = item.config as ShortTextConfig;
      const kind = cfg.validation.kind;
      return (
        <input
          {...fieldProps}
          className="pf-input"
          type={kind === "email" ? "email" : kind === "url" ? "url" : "text"}
          inputMode={kind === "number" ? "decimal" : kind === "email" ? "email" : kind === "url" ? "url" : undefined}
          autoComplete="off"
          maxLength={cfg.max_length ?? 1000}
          placeholder="Your answer"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
    case "paragraph": {
      const cfg = item.config as ParagraphConfig;
      const s = typeof value === "string" ? value : "";
      return (
        <div className="flex flex-col gap-1">
          <textarea
            {...fieldProps}
            className="pf-input min-h-[7rem] resize-y"
            maxLength={cfg.max_length}
            placeholder="Your answer"
            value={s}
            onChange={(e) => onChange(e.target.value)}
          />
          {s.length > cfg.max_length * 0.8 && (
            <span className="self-end text-xs" style={{ color: "var(--pf-muted)" }}>
              {s.length} / {cfg.max_length}
            </span>
          )}
        </div>
      );
    }
    case "multiple_choice":
      return <Choices {...p} multi={false} />;
    case "checkboxes":
      return <Choices {...p} multi />;
    case "dropdown": {
      const cfg = item.config as DropdownConfig;
      const v = value as ChoiceAnswer | undefined;
      const opts = visibleOptions(cfg.options, p.remaining, v && "option" in v ? [v.option] : []);
      return (
        <select
          {...fieldProps}
          className="pf-input"
          value={v && "option" in v ? v.option : ""}
          onChange={(e) => onChange(e.target.value ? { option: e.target.value } : undefined)}
        >
          <option value="">Choose</option>
          {opts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label || "Untitled option"}
              {p.showRemaining && p.remaining?.[o.id] !== undefined ? ` (${placesLeft(p.remaining[o.id])})` : ""}
            </option>
          ))}
        </select>
      );
    }
    case "linear_scale": {
      const cfg = item.config as LinearScaleConfig;
      const steps: number[] = [];
      for (let n = cfg.min; n <= cfg.max; n++) steps.push(n);
      return (
        <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby={p.labelId} aria-describedby={describedBy}>
          <div className="flex flex-wrap gap-2">
            {steps.map((n) => (
              <label key={n} className="pf-step flex-1 basis-11">
                <input
                  type="radio"
                  name={`${domId}-scale`}
                  value={n}
                  checked={value === n}
                  aria-label={
                    n === cfg.min && cfg.min_label
                      ? `${n}, ${cfg.min_label}`
                      : n === cfg.max && cfg.max_label
                        ? `${n}, ${cfg.max_label}`
                        : String(n)
                  }
                  onChange={() => onChange(n)}
                />
                <span aria-hidden="true">{n}</span>
              </label>
            ))}
          </div>
          {(cfg.min_label || cfg.max_label) && (
            <div className="flex justify-between gap-4 text-sm" style={{ color: "var(--pf-muted)" }} aria-hidden="true">
              <span>{cfg.min_label}</span>
              <span className="text-right">{cfg.max_label}</span>
            </div>
          )}
        </div>
      );
    }
    case "rating": {
      const cfg = item.config as RatingConfig;
      const Icon = cfg.icon === "heart" ? Heart : cfg.icon === "thumb" ? ThumbsUp : Star;
      const word = cfg.icon === "heart" ? "heart" : cfg.icon === "thumb" ? "thumbs up" : "star";
      const v = typeof value === "number" ? value : 0;
      return (
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-labelledby={p.labelId} aria-describedby={describedBy}>
          {Array.from({ length: cfg.max }, (_, i) => i + 1).map((n) => (
            <label key={n} className="pf-rate" data-on={n <= v}>
              <input
                type="radio"
                name={`${domId}-rate`}
                value={n}
                checked={v === n}
                aria-label={`${n} ${word}${n === 1 || word === "thumbs up" ? "" : "s"} of ${cfg.max}`}
                onChange={() => onChange(n)}
              />
              <Icon className={cn("h-8 w-8", n <= v && "fill-current")} aria-hidden="true" />
            </label>
          ))}
        </div>
      );
    }
    case "date":
      return <DateControl {...p} fieldProps={fieldProps} />;
    case "time":
      return <TimeControl {...p} fieldProps={fieldProps} />;
    case "choice_grid":
    case "checkbox_grid":
      return <GridControl {...p} />;
    case "file_upload": {
      const cfg = item.config as FileUploadConfig;
      if (p.renderUpload && p.mode === "answer")
        return <>{p.renderUpload(item as FormItem<"file_upload">, Array.isArray(value) ? (value as string[]) : [], (ids) => onChange(ids.length ? ids : undefined))}</>;
      return (
        <div className="flex flex-col gap-2">
          <button type="button" className="pf-btn pf-btn-ghost self-start border" style={{ borderColor: "var(--pf-border)" }} disabled>
            <Upload className="h-4 w-4" /> Add {cfg.max_files === 1 ? "a file" : "files"}
          </button>
          <p className="text-sm" style={{ color: "var(--pf-muted)" }}>
            {fileHint(cfg)}
            {p.mode === "preview" ? " Files aren't sent from a preview." : ""}
          </p>
        </div>
      );
    }
    default:
      return null;
  }
}

const GROUP_WORDS: Record<string, string> = {
  images: "pictures",
  pdf: "PDFs",
  documents: "documents",
  spreadsheets: "spreadsheets",
  audio: "audio",
  video: "videos",
};

export function fileHint(cfg: FileUploadConfig): string {
  const kinds = cfg.kinds.map((k) => GROUP_WORDS[k] ?? k);
  const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} or ${kinds[kinds.length - 1]}` : kinds[0];
  return `Up to ${cfg.max_files} ${cfg.max_files === 1 ? "file" : "files"}: ${list}, ${cfg.max_size_mb} MB each at most.`;
}

function placesLeft(n: number): string {
  return n <= 0 ? "full" : `${n} left`;
}

/** Options to show: full ones hidden (unless already chosen). */
function visibleOptions(options: FormOption[], remaining: Record<string, number> | undefined, chosen: string[]): FormOption[] {
  if (!remaining) return options;
  return options.filter((o) => remaining[o.id] === undefined || remaining[o.id] > 0 || chosen.includes(o.id));
}

function Choices(p: QuestionProps & { multi: boolean; describedBy?: string }) {
  const { item, value, onChange, domId, multi, assetUrls } = p;
  const cfg = item.config as MultipleChoiceConfig | CheckboxesConfig;
  const chosenIds = multi
    ? ((value as CheckboxAnswer | undefined)?.options ?? [])
    : value && "option" in (value as ChoiceAnswer)
      ? [(value as { option: string }).option]
      : [];
  const ordered = useMemo(
    () => (cfg.shuffle ? shuffled(cfg.options, p.seed + item.id.length) : cfg.options),
    [cfg.shuffle, cfg.options, p.seed, item.id]
  );
  const opts = visibleOptions(ordered, p.remaining, chosenIds);
  const otherOn = multi
    ? (value as CheckboxAnswer | undefined)?.other !== undefined
    : !!value && "other" in (value as ChoiceAnswer);
  const otherText = multi
    ? ((value as CheckboxAnswer | undefined)?.other ?? "")
    : value && "other" in (value as ChoiceAnswer)
      ? (value as { other: string }).other
      : "";
  const allFull = p.remaining && cfg.options.length > 0 && opts.length === 0 && !cfg.other;

  const toggle = (id: string) => {
    if (!multi) return onChange({ option: id });
    const cur = (value as CheckboxAnswer | undefined) ?? { options: [] };
    const options = cur.options.includes(id) ? cur.options.filter((x) => x !== id) : [...cur.options, id];
    const out: CheckboxAnswer = { options };
    if (cur.other !== undefined) out.other = cur.other;
    onChange(isEmpty(item, out) ? undefined : out);
  };
  const setOther = (on: boolean, text: string) => {
    if (!multi) return onChange(on ? { other: text } : undefined);
    const cur = (value as CheckboxAnswer | undefined) ?? { options: [] };
    const out: CheckboxAnswer = { options: cur.options };
    if (on) out.other = text;
    onChange(isEmpty(item, out) ? undefined : out);
  };

  return (
    <div className="flex flex-col gap-2">
      {allFull && (
        <p className="text-sm" style={{ color: "var(--pf-muted)" }}>
          Every option is full.
        </p>
      )}
      {opts.map((o) => {
        const img = o.image_asset_id ? assetUrls[o.image_asset_id] : undefined;
        const left = p.showRemaining ? p.remaining?.[o.id] : undefined;
        return (
          <label key={o.id} className="pf-choice">
            <input
              type={multi ? "checkbox" : "radio"}
              name={`${domId}-choice`}
              checked={chosenIds.includes(o.id)}
              onChange={() => toggle(o.id)}
              aria-describedby={p.describedBy}
            />
            {img && <img src={img} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" />}
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{o.label || "Untitled option"}</span>
            {left !== undefined && (
              <span className="shrink-0 text-xs font-medium" style={{ color: "var(--pf-muted)" }}>
                {placesLeft(left)}
              </span>
            )}
          </label>
        );
      })}
      {cfg.other && (
        <div className="flex flex-col gap-2">
          <label className="pf-choice">
            <input
              type={multi ? "checkbox" : "radio"}
              name={`${domId}-choice`}
              checked={otherOn}
              onChange={(e) => setOther(multi ? e.target.checked : true, otherText)}
            />
            <span>Other</span>
          </label>
          {otherOn && (
            <input
              className="pf-input"
              aria-label="Other: say what"
              placeholder="Say what"
              maxLength={500}
              value={otherText}
              onChange={(e) => setOther(true, e.target.value)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The room a box has, kept up to date (grids pick table or phone rows by it). */
function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * A multiple-choice or checkbox grid. With room, a real table: column
 * headers, a row header per row, a radio or checkbox in each cell. On a
 * phone (or a narrow card), each row is its own group (its words as the
 * legend) with the columns as big chips that wrap, so nothing scrolls
 * sideways. "Only one per column": picking a column moves it from the row
 * that had it.
 */
function GridControl(p: QuestionProps & { describedBy?: string }) {
  const { item, value, onChange, domId } = p;
  const cfg = item.config as ChoiceGridConfig;
  const multi = item.kind === "checkbox_grid";
  const [box, width] = useWidth<HTMLDivElement>();
  const rows = useMemo(
    () => (cfg.shuffle_rows ? shuffled(cfg.rows, p.seed + item.id.length) : cfg.rows),
    [cfg.shuffle_rows, cfg.rows, p.seed, item.id]
  );
  const cur = ((value as GridAnswer | undefined)?.rows ?? {}) as Record<string, string | string[]>;
  const table = width >= 600 && width >= 150 + cfg.columns.length * 76;

  const put = (next: Record<string, string | string[]>) => {
    const out: GridAnswer = { rows: next };
    onChange(isEmpty(item, out) ? undefined : out);
  };
  const pick = (rowId: string, colId: string) => {
    if (multi) {
      const had = Array.isArray(cur[rowId]) ? (cur[rowId] as string[]) : [];
      const list = had.includes(colId) ? had.filter((c) => c !== colId) : [...had, colId];
      const next = { ...cur };
      if (list.length) next[rowId] = list;
      else delete next[rowId];
      return put(next);
    }
    const next: Record<string, string | string[]> = {};
    for (const [r, c] of Object.entries(cur)) if (!(cfg.one_per_column && c === colId)) next[r] = c;
    next[rowId] = colId;
    put(next);
  };
  const on = (rowId: string, colId: string) => (multi ? Array.isArray(cur[rowId]) && (cur[rowId] as string[]).includes(colId) : cur[rowId] === colId);
  const rowWords = (label: string, i: number) => label || `Row ${i + 1}`;
  const colWords = (label: string, i: number) => label || `Column ${i + 1}`;

  return (
    <div ref={box} className="min-w-0" data-grid={table ? "table" : "rows"}>
      {table ? (
        <table className="pf-grid">
          <thead>
            <tr>
              <td />
              {cfg.columns.map((c, ci) => (
                <th key={c.id} scope="col">
                  {colWords(c.label, ci)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const ri = cfg.rows.indexOf(r);
              return (
                <tr key={r.id}>
                  <th scope="row">{rowWords(r.label, ri)}</th>
                  {cfg.columns.map((c, ci) => (
                    <td key={c.id}>
                      <label className="pf-grid-cell">
                        <input
                          type={multi ? "checkbox" : "radio"}
                          name={`${domId}-${r.id}`}
                          checked={on(r.id, c.id)}
                          onChange={() => pick(r.id, c.id)}
                          aria-label={`${rowWords(r.label, ri)}: ${colWords(c.label, ci)}`}
                          aria-describedby={p.describedBy}
                        />
                      </label>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map((r) => {
            const ri = cfg.rows.indexOf(r);
            return (
              <fieldset key={r.id} className="flex min-w-0 flex-col gap-2" aria-describedby={p.describedBy}>
                <legend className="mb-2 text-[15px] font-medium [overflow-wrap:anywhere]">{rowWords(r.label, ri)}</legend>
                <div className="flex flex-wrap gap-2">
                  {cfg.columns.map((c, ci) => (
                    <label key={c.id} className="pf-step pf-chip">
                      <input
                        type={multi ? "checkbox" : "radio"}
                        name={`${domId}-${r.id}`}
                        checked={on(r.id, c.id)}
                        onChange={() => pick(r.id, c.id)}
                      />
                      <span>{colWords(c.label, ci)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
        </div>
      )}
      {multi || !cfg.one_per_column ? null : (
        <p className="mt-2 text-sm" style={{ color: "var(--pf-muted)" }}>
          Each column can be picked in one row only.
        </p>
      )}
    </div>
  );
}

type FieldProps = Record<string, unknown>;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function DateControl(p: QuestionProps & { fieldProps: FieldProps }) {
  const cfg = p.item.config as DateConfig;
  const v = typeof p.value === "string" ? p.value : "";
  if (cfg.include_year) {
    return (
      <input
        {...p.fieldProps}
        className="pf-input sm:max-w-xs"
        type={cfg.include_time ? "datetime-local" : "date"}
        value={v}
        onChange={(e) => p.onChange(e.target.value || undefined)}
      />
    );
  }
  // No year (birthdays): month and day, and a time if asked.
  const [md, time = ""] = v.split("T");
  const [mm = "", dd = ""] = md ? md.split("-") : [];
  const put = (m: string, d: string, t: string) => {
    if (!m && !d && !t) return p.onChange(undefined);
    p.onChange(`${m || "00"}-${d || "00"}${cfg.include_time ? `T${t}` : ""}`);
  };
  const days = mm ? new Date(2024, Number(mm), 0).getDate() : 31;
  return (
    <div className="flex flex-wrap gap-2">
      <select
        {...p.fieldProps}
        aria-label="Month"
        className="pf-input w-auto min-w-[9rem]"
        value={mm === "00" ? "" : mm}
        onChange={(e) => put(e.target.value, dd === "00" ? "" : dd, time)}
      >
        <option value="">Month</option>
        {MONTHS.map((m, i) => (
          <option key={m} value={String(i + 1).padStart(2, "0")}>
            {m}
          </option>
        ))}
      </select>
      <select
        aria-label="Day"
        aria-invalid={p.error ? true : undefined}
        className="pf-input w-auto min-w-[5.5rem]"
        value={dd === "00" ? "" : dd}
        onChange={(e) => put(mm === "00" ? "" : mm, e.target.value, time)}
      >
        <option value="">Day</option>
        {Array.from({ length: days }, (_, i) => String(i + 1).padStart(2, "0")).map((d) => (
          <option key={d} value={d}>
            {Number(d)}
          </option>
        ))}
      </select>
      {cfg.include_time && (
        <input
          aria-label="Time"
          className="pf-input w-auto"
          type="time"
          value={time}
          onChange={(e) => put(mm === "00" ? "" : mm, dd === "00" ? "" : dd, e.target.value)}
        />
      )}
    </div>
  );
}

function TimeControl(p: QuestionProps & { fieldProps: FieldProps }) {
  const cfg = p.item.config as TimeConfig;
  const v = typeof p.value === "string" ? p.value : "";
  if (cfg.mode === "time")
    return (
      <input
        {...p.fieldProps}
        className="pf-input sm:max-w-[12rem]"
        type="time"
        value={v}
        onChange={(e) => p.onChange(e.target.value || undefined)}
      />
    );
  return <DurationControl {...p} value={v} />;
}

/** A duration: hours, minutes, seconds, sent as ``H:MM:SS``. */
function DurationControl(p: QuestionProps & { fieldProps: FieldProps; value: string }) {
  const parse = (v: string) => {
    const [h = "", m = "", s = ""] = v ? v.split(":") : [];
    return { h, m, s };
  };
  const [parts, setParts] = useState(() => parse(p.value));
  const lastSent = useRef(p.value);
  useEffect(() => {
    // Cleared from outside (Clear form): start again.
    if (p.value !== lastSent.current) {
      setParts(parse(p.value));
      lastSent.current = p.value;
    }
  }, [p.value]);
  const put = (next: { h: string; m: string; s: string }) => {
    setParts(next);
    const out =
      !next.h && !next.m && !next.s
        ? ""
        : `${Number(next.h || 0)}:${String(Math.min(59, Number(next.m || 0))).padStart(2, "0")}:${String(
            Math.min(59, Number(next.s || 0))
          ).padStart(2, "0")}`;
    lastSent.current = out;
    p.onChange(out || undefined);
  };
  const box = "pf-input w-20 text-center";
  const digits = (v: string, n: number) => v.replace(/\D/g, "").slice(0, n);
  return (
    <div className="flex items-center gap-2">
      <input
        {...p.fieldProps}
        aria-label="Hours"
        className={box}
        inputMode="numeric"
        placeholder="h"
        value={parts.h}
        onChange={(e) => put({ ...parts, h: digits(e.target.value, 3) })}
      />
      <span aria-hidden="true">:</span>
      <input
        aria-label="Minutes"
        className={box}
        inputMode="numeric"
        placeholder="mm"
        value={parts.m}
        onChange={(e) => put({ ...parts, m: digits(e.target.value, 2) })}
      />
      <span aria-hidden="true">:</span>
      <input
        aria-label="Seconds"
        className={box}
        inputMode="numeric"
        placeholder="ss"
        value={parts.s}
        onChange={(e) => put({ ...parts, s: digits(e.target.value, 2) })}
      />
    </div>
  );
}
