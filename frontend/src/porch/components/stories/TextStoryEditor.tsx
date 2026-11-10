import { Check } from "lucide-react";
import { useEffect, useRef } from "react";

import { STORY_BACKGROUNDS, type StoryBackground } from "@/api/porch";
import { cn } from "@/utils/cn";

import { BACKGROUND_LOOK } from "./look";

export const TEXT_STORY_MAX = 500;

/** A text story's words, typed straight onto its colour (big, centred). */
export function TextStoryEditor({ text, onText, background }: { text: string; onText: (v: string) => void; background: StoryBackground }) {
  const look = BACKGROUND_LOOK[background];
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, []);
  const n = text.length;
  const size = n < 40 ? 9 : n < 90 ? 7.2 : n < 180 ? 5.8 : 4.8;
  return (
    <div className="absolute inset-0 flex items-center justify-center px-[8cqw]" style={{ background: look.css, containerType: "inline-size" }}>
      <label className="w-full">
        <span className="sr-only">Your story's words</span>
        <textarea
          ref={box}
          value={text}
          maxLength={TEXT_STORY_MAX}
          onChange={(e) => onText(e.target.value)}
          placeholder="Type something"
          rows={4}
          className={cn(
            "block w-full resize-none bg-transparent text-center font-bold leading-tight outline-none",
            look.dark ? "text-[#2A2118] placeholder:text-[#2A2118]/50" : "text-white placeholder:text-white/60",
          )}
          style={{ fontSize: `${size}cqw` }}
        />
      </label>
    </div>
  );
}

/** The six colours, as round swatches. */
export function BackgroundPicker({ value, onChange }: { value: StoryBackground; onChange: (v: StoryBackground) => void }) {
  return (
    <div role="radiogroup" aria-label="Background" className="flex items-center justify-center gap-2.5">
      {STORY_BACKGROUNDS.map((bg) => {
        const on = value === bg;
        return (
          <button
            key={bg}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={BACKGROUND_LOOK[bg].label}
            onClick={() => onChange(bg)}
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-black transition focus-visible:outline-none focus-visible:ring-white",
              on ? "ring-white" : "ring-transparent",
            )}
            style={{ background: BACKGROUND_LOOK[bg].css }}
          >
            {on && <Check className={cn("h-4 w-4", BACKGROUND_LOOK[bg].dark ? "text-[#2A2118]" : "text-white")} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
