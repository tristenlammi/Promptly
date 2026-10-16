import { useEffect, useState } from "react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import {
  MARGIN_PRESETS,
  PAPER_LABEL,
  PAPER_MM,
  normalisePageSetup,
  paperMm,
  type Margins,
  type NumberStyle,
  type PageNumbers,
  type PageSetup,
  type PaperSize,
} from "@/lib/pageSetup";
import { cn } from "@/utils/cn";

/**
 * Page setup for a Doc (WP-6.4): paper, orientation, margins, header,
 * footer and page numbers. Changes are applied to the document's Y.Doc by
 * the caller, so everyone editing sees them, and they drive the PDF, the
 * .docx and printing.
 */
export function PageSetupDialog({
  open,
  value,
  readOnly,
  onClose,
  onApply,
}: {
  open: boolean;
  value: PageSetup;
  readOnly: boolean;
  onClose: () => void;
  onApply: (next: PageSetup) => void;
}) {
  const [draft, setDraft] = useState<PageSetup>(value);
  useEffect(() => {
    if (open) setDraft(value);
    // Reset only when (re)opened — a collaborator's change mid-edit shouldn't
    // wipe what's being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = <K extends keyof PageSetup>(key: K, v: PageSetup[K]) => setDraft((d) => ({ ...d, [key]: v }));
  const setMargin = (side: keyof Margins, v: string) =>
    setDraft((d) => ({ ...d, margins: { ...d.margins, [side]: v === "" ? 0 : Number(v) } }));
  const preset = MARGIN_PRESETS.find((p) => JSON.stringify(p.margins) === JSON.stringify(draft.margins));

  const field = "h-9 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-sm disabled:opacity-60";
  const label = "mb-1 block text-xs font-medium text-[var(--text-muted)]";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Page setup"
      description={readOnly ? "You can view this document's page setup." : "Used for the PDF, Word file and printing."}
      widthClass="max-w-2xl"
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                onApply(normalisePageSetup(draft));
                onClose();
              }}
            >
              Apply
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-5 sm:flex-row">
        <fieldset disabled={readOnly} className="grid min-w-0 flex-1 grid-cols-2 gap-3">
          <div className="col-span-2 sm:col-span-1">
            <label className={label} htmlFor="ps-size">
              Paper size
            </label>
            <select
              id="ps-size"
              className={field}
              value={draft.size}
              onChange={(e) => set("size", e.target.value as PaperSize)}
            >
              {(Object.keys(PAPER_MM) as PaperSize[]).map((s) => (
                <option key={s} value={s}>
                  {PAPER_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-2 sm:col-span-1">
            <span className={label}>Orientation</span>
            <div role="radiogroup" aria-label="Orientation" className="flex gap-1">
              {(["portrait", "landscape"] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  role="radio"
                  aria-checked={draft.orientation === o}
                  onClick={() => set("orientation", o)}
                  className={cn(
                    "h-9 flex-1 rounded-md border text-sm capitalize",
                    draft.orientation === o
                      ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]"
                  )}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>

          <div className="col-span-2">
            <span className={label}>Margins (mm)</span>
            <div className="mb-2 flex flex-wrap gap-1">
              {MARGIN_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => set("margins", { ...p.margins })}
                  className={cn(
                    "h-7 rounded-md border px-2.5 text-xs",
                    preset?.label === p.label
                      ? "border-[var(--accent)] bg-[var(--accent)]/10"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]"
                  )}
                >
                  {p.label}
                </button>
              ))}
              {!preset && <span className="px-1 text-xs leading-7 text-[var(--text-muted)]">Custom</span>}
            </div>
            <div className="grid grid-cols-4 gap-2">
              {(["top", "bottom", "left", "right"] as const).map((side) => (
                <div key={side}>
                  <label className="mb-0.5 block text-[11px] capitalize text-[var(--text-muted)]" htmlFor={`ps-m-${side}`}>
                    {side}
                  </label>
                  <input
                    id={`ps-m-${side}`}
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    className={field}
                    value={draft.margins[side]}
                    onChange={(e) => setMargin(side, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="col-span-2">
            <label className={label} htmlFor="ps-header">
              Header
            </label>
            <input
              id="ps-header"
              className={field}
              maxLength={200}
              placeholder="Text at the top of every page"
              value={draft.header}
              onChange={(e) => set("header", e.target.value)}
            />
          </div>
          <div className="col-span-2">
            <label className={label} htmlFor="ps-footer">
              Footer
            </label>
            <input
              id="ps-footer"
              className={field}
              maxLength={200}
              placeholder="Text at the bottom of every page"
              value={draft.footer}
              onChange={(e) => set("footer", e.target.value)}
            />
          </div>
          <div>
            <label className={label} htmlFor="ps-numbers">
              Page numbers
            </label>
            <select
              id="ps-numbers"
              className={field}
              value={draft.pageNumbers}
              onChange={(e) => set("pageNumbers", e.target.value as PageNumbers)}
            >
              <option value="none">None</option>
              <option value="bottom-center">Bottom, centre</option>
              <option value="bottom-right">Bottom, right</option>
              <option value="top-right">Top, right</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor="ps-style">
              Number style
            </label>
            <select
              id="ps-style"
              className={field}
              value={draft.numberStyle}
              disabled={draft.pageNumbers === "none"}
              onChange={(e) => set("numberStyle", e.target.value as NumberStyle)}
            >
              <option value="n">1</option>
              <option value="page-n">Page 1</option>
              <option value="page-n-of-m">Page 1 of 3</option>
            </select>
          </div>
        </fieldset>
        <PagePicture setup={draft} />
      </div>
    </Modal>
  );
}

/** A small drawing of the page: paper shape, margins, header/footer and
 *  where the number goes. */
function PagePicture({ setup }: { setup: PageSetup }) {
  const s = normalisePageSetup(setup);
  const [w, h] = paperMm(s);
  const k = 150 / Math.max(w, h);
  const m = s.margins;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const number = s.numberStyle === "n" ? "1" : s.numberStyle === "page-n" ? "Page 1" : "Page 1 of 3";
  return (
    <div className="flex shrink-0 items-start justify-center sm:w-44" aria-hidden>
      <div
        data-testid="page-picture"
        className="relative rounded-sm border border-[var(--border)] bg-white shadow-sm"
        style={{ width: w * k, height: h * k }}
      >
        <div
          className="absolute border border-dashed border-sky-400/70"
          style={{ top: pct(m.top, h), bottom: pct(m.bottom, h), left: pct(m.left, w), right: pct(m.right, w) }}
        >
          <div className="space-y-1 p-1">
            {[90, 75, 85, 60, 80].map((x, i) => (
              <div key={i} className="h-[3px] rounded bg-neutral-300" style={{ width: `${x}%` }} />
            ))}
          </div>
        </div>
        {s.header && (
          <div
            className={cn(
              "absolute truncate text-center text-[7px] leading-none text-neutral-500",
              s.pageNumbers === "top-right" ? "inset-x-[28%]" : "inset-x-1"
            )}
            style={{ top: pct(m.top / 2.6, h) }}
          >
            {s.header}
          </div>
        )}
        {(s.footer || s.pageNumbers === "bottom-center") && (
          <div
            className={cn(
              "absolute truncate text-center text-[7px] leading-none text-neutral-500",
              // Leave the corner to a bottom-right number.
              s.pageNumbers === "bottom-right" ? "inset-x-[28%]" : "inset-x-1"
            )}
            style={{ bottom: pct(m.bottom / 2.6, h) }}
          >
            {[s.footer, s.pageNumbers === "bottom-center" ? number : ""].filter(Boolean).join("  ·  ")}
          </div>
        )}
        {s.pageNumbers === "bottom-right" && (
          <div className="absolute right-1 text-[7px] leading-none text-neutral-500" style={{ bottom: pct(m.bottom / 2.6, h) }}>
            {number}
          </div>
        )}
        {s.pageNumbers === "top-right" && (
          <div className="absolute right-1 text-[7px] leading-none text-neutral-500" style={{ top: pct(m.top / 2.6, h) }}>
            {number}
          </div>
        )}
      </div>
    </div>
  );
}
