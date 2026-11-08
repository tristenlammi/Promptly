import { Check, ImageOff, ImagePlus } from "lucide-react";
import { useState } from "react";

import type { FormFont, FormTheme } from "@/api/forms";
import { cn } from "@/utils/cn";

import { BUILTIN_HEADERS, HeaderArt } from "../headers";
import { ACCENTS, ACCENT_KEYS, FONTS, themeVars } from "../theme";
import { PicturePicker } from "./PicturePicker";
import type { FormDoc } from "./useFormDoc";

/**
 * The form's look: an accent colour (ten presets, each readable in light
 * and dark — no free picker, so contrast stays good), a header picture
 * (yours, from Photos, or one of a dozen built-in ones), and a font. The
 * background is a soft tint of the accent; light or dark follows the
 * device of whoever answers.
 */
export function LookPanel({ doc, fileId }: { doc: FormDoc; fileId: string }) {
  const theme = doc.def.theme;
  const [picking, setPicking] = useState(false);
  const setTheme = (patch: Partial<FormTheme>) => doc.update((d) => ({ ...d, theme: { ...d.theme, ...patch } }));
  const headerUrl = theme.header_asset_id ? doc.assetUrls[theme.header_asset_id] : undefined;

  return (
    <div className="flex flex-col gap-5">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[var(--text)]">Colour</legend>
        <div className="flex flex-wrap gap-2">
          {ACCENT_KEYS.map((key) => {
            const on = theme.accent === key;
            return (
              <label
                key={key}
                title={ACCENTS[key].label}
                className={cn(
                  "relative flex h-11 w-11 cursor-pointer items-center justify-center rounded-full ring-offset-2 ring-offset-[var(--surface)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--text)]",
                  on && "ring-2 ring-[var(--text)]"
                )}
                style={{ background: ACCENTS[key].light }}
              >
                <input
                  type="radio"
                  name="form-accent"
                  className="sr-only"
                  checked={on}
                  onChange={() => setTheme({ accent: key })}
                  aria-label={ACCENTS[key].label}
                />
                {on && <Check className="h-5 w-5 text-white" aria-hidden="true" />}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[var(--text)]">Header picture</legend>
        <div className="pf-theme grid grid-cols-3 gap-2 rounded-lg bg-transparent sm:grid-cols-4" data-scheme="app" style={{ ...themeVars(theme.accent), background: "transparent" }}>
          <HeaderChoice
            label="No picture"
            selected={!theme.header_asset_id && !theme.header_builtin}
            onSelect={() => setTheme({ header_asset_id: null, header_builtin: null })}
          >
            <span className="flex h-full w-full items-center justify-center gap-1 text-xs" style={{ background: "var(--pf-band)", color: "var(--pf-text)" }}>
              <ImageOff className="h-4 w-4" aria-hidden="true" /> None
            </span>
          </HeaderChoice>
          {theme.header_asset_id && (
            <HeaderChoice label="Your picture" selected onSelect={() => undefined}>
              {headerUrl ? <img src={headerUrl} alt="" className="h-full w-full object-cover" /> : <span className="text-xs">Your picture</span>}
            </HeaderChoice>
          )}
          <HeaderChoice label="Upload or choose from Photos" selected={false} onSelect={() => setPicking(true)}>
            <span className="flex h-full w-full items-center justify-center gap-1 border border-dashed text-xs" style={{ borderColor: "var(--pf-border)", color: "var(--pf-text)" }}>
              <ImagePlus className="h-4 w-4" aria-hidden="true" /> Your own
            </span>
          </HeaderChoice>
          {BUILTIN_HEADERS.map((h) => (
            <HeaderChoice
              key={h.id}
              label={h.label}
              selected={!theme.header_asset_id && theme.header_builtin === h.id}
              onSelect={() => setTheme({ header_builtin: h.id, header_asset_id: null })}
            >
              <HeaderArt id={h.id} className="h-full w-full" />
            </HeaderChoice>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-[var(--text)]">Font</legend>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(FONTS) as FormFont[]).map((f) => (
            <label
              key={f}
              className={cn(
                "flex min-h-[44px] cursor-pointer items-center rounded-lg border px-4 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]",
                theme.font === f ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] hover:bg-[var(--hover)]"
              )}
              style={{ fontFamily: FONTS[f].stack }}
            >
              <input type="radio" name="form-font" className="sr-only" checked={theme.font === f} onChange={() => setTheme({ font: f })} />
              {FONTS[f].label}
            </label>
          ))}
        </div>
      </fieldset>

      {picking && (
        <PicturePicker
          open
          title="Header picture"
          onClose={() => setPicking(false)}
          fileId={fileId}
          onPicked={(a) => {
            doc.addAssetUrl(a.id, a.url);
            setTheme({ header_asset_id: a.id, header_builtin: null });
          }}
        />
      )}
    </div>
  );
}

function HeaderChoice({
  label,
  selected,
  onSelect,
  children,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      className={cn(
        "relative block overflow-hidden rounded-md outline-none ring-offset-2 ring-offset-[var(--surface)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        selected && "ring-2 ring-[var(--text)]"
      )}
      style={{ aspectRatio: "4 / 1.6" }}
    >
      {children}
    </button>
  );
}
