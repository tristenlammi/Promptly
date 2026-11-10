import { useState, type ReactNode } from "react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";

/**
 * "Name it": one box and two buttons, in place of the browser's own
 * pop-up. Enter saves, Escape cancels. Photos' own for now; the shared
 * one replaces it when it arrives.
 */
export function NameDialog({
  title,
  description,
  label,
  placeholder,
  initial = "",
  confirmLabel = "Create",
  onClose,
  onSubmit,
}: {
  title: string;
  description?: string;
  /** What the box is for, read out by screen readers. */
  label: string;
  placeholder?: string;
  initial?: string;
  confirmLabel?: ReactNode;
  onClose: () => void;
  /** Resolves when it's done (the dialog shows it's busy until then). */
  onSubmit: (name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ok = !!name.trim() && !busy;
  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      await onSubmit(name.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description}
      widthClass="max-w-sm"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!ok} loading={busy} onClick={() => void submit()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          autoFocus
          aria-label={label}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder={placeholder}
          maxLength={200}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
      </form>
    </Modal>
  );
}
