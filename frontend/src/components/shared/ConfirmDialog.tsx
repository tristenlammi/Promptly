import { type ReactNode } from "react";
import { create } from "zustand";

import { Button } from "./Button";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  /** Dialog heading. Defaults to "Are you sure?". */
  title?: string;
  /** Body copy — string or rich node. */
  message: ReactNode;
  /** Primary button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Paint the primary button as destructive (red). */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

interface ConfirmState {
  current: PendingConfirm | null;
  request: (opts: ConfirmOptions) => Promise<boolean>;
  settle: (ok: boolean) => void;
}

let seq = 0;

const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,
  request: (opts) =>
    new Promise<boolean>((resolve) => {
      // If a confirm is already open, resolve it as cancelled before
      // replacing it — two stacked confirms would be confusing.
      const existing = get().current;
      if (existing) existing.resolve(false);
      set({ current: { ...opts, id: ++seq, resolve } });
    }),
  settle: (ok) => {
    const cur = get().current;
    if (!cur) return;
    cur.resolve(ok);
    set({ current: null });
  },
}));

/**
 * Promise-based confirm — a styled replacement for `window.confirm()`.
 * Resolves `true` if the user confirms, `false` on cancel / Escape /
 * backdrop click.
 *
 *   if (await confirm({ message: "Delete this task?", danger: true })) {
 *     // ...
 *   }
 *
 * Requires <ConfirmHost /> mounted once at the app root.
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().request(opts);
}

/** Single mounted host that renders whatever confirm is pending. */
export function ConfirmHost() {
  const current = useConfirmStore((s) => s.current);
  const settle = useConfirmStore((s) => s.settle);

  return (
    <Modal
      open={!!current}
      onClose={() => settle(false)}
      title={current?.title ?? "Are you sure?"}
      widthClass="max-w-sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => settle(false)}>
            {current?.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={current?.danger ? "danger" : "primary"}
            size="sm"
            onClick={() => settle(true)}
            autoFocus
          >
            {current?.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-[var(--text-muted)]">
        {current?.message}
      </div>
    </Modal>
  );
}
