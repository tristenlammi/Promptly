import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";

/**
 * A text input that edits a local draft and commits it on blur or Enter
 * (Escape puts the saved value back).
 *
 * Board column, label, checklist and field names were bound straight to the
 * server's copy and saved on every keystroke: characters vanished until the
 * round trip came back, the caret jumped to the end, and each keystroke
 * re-embedded the board (R-169). While the input has focus the server value
 * never overwrites what you're typing; once it's blurred it follows the
 * server again (a teammate's rename shows up).
 */
export function DraftInput({
  value,
  onCommit,
  ...rest
}: {
  value: string;
  onCommit: (next: string) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "defaultValue">) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => {
        focused.current = true;
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        focused.current = false;
        if (cancelled.current) cancelled.current = false;
        else commit();
        rest.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(value);
          (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }
        rest.onKeyDown?.(e);
      }}
    />
  );
}
