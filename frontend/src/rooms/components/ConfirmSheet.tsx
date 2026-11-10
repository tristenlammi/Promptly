import { useEffect, useState } from "react";
import { create } from "zustand";

import { Field, ItemButton, Sheet, TextInput } from "@/items/ui";

/**
 * "Are you sure?" for questions asked from inside one of Rooms' sheets
 * (space and room settings). It is a sheet itself, so it stacks on top of
 * the one that asked; the app-wide confirm sits underneath sheets. Outside
 * a sheet, use the shared ``confirm()``.
 */
export interface AskOptions {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  /** Make them type this (a space's name) before the button works. */
  typeToConfirm?: string;
}

interface AskState {
  current: (AskOptions & { resolve: (ok: boolean) => void }) | null;
  settle: (ok: boolean) => void;
}

const useAsk = create<AskState>((set, get) => ({
  current: null,
  settle: (ok) => {
    const cur = get().current;
    if (!cur) return;
    set({ current: null });
    cur.resolve(ok);
  },
}));

export function askInSheet(opts: AskOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useAsk.getState().current?.resolve(false);
    useAsk.setState({ current: { ...opts, resolve } });
  });
}

/** Mounted once by RoomsApp. */
export function ConfirmSheetHost() {
  const current = useAsk((s) => s.current);
  const settle = useAsk((s) => s.settle);
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [current]);
  // Leaving Rooms with a question open answers it "no".
  useEffect(() => () => useAsk.getState().settle(false), []);

  const need = current?.typeToConfirm;
  const ready = !need || typed.trim() === need;

  return (
    <Sheet open={!!current} onClose={() => settle(false)} title={current?.title} size="sm">
      {current && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) settle(true);
          }}
        >
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">{current.message}</p>
          {need && (
            <Field label={`Type "${need}" to go ahead`}>
              <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-autofocus="" />
            </Field>
          )}
          <div className="flex justify-end gap-2">
            {/* A question that deletes something starts on Cancel. */}
            <ItemButton type="button" variant="ghost" onClick={() => settle(false)} data-autofocus={need ? undefined : ""}>
              Cancel
            </ItemButton>
            <ItemButton type="submit" variant={current.danger ? "danger" : "primary"} disabled={!ready}>
              {current.confirmLabel}
            </ItemButton>
          </div>
        </form>
      )}
    </Sheet>
  );
}
