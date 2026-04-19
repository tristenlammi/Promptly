import { useState } from "react";
import { Copy, Check, Download } from "lucide-react";

import { Button } from "@/components/shared/Button";

/** Show + copy + download a freshly-issued set of one-shot backup codes.
 *
 * Used in two places: the enrollment wizard's final step, and the
 * settings panel's "Regenerate backup codes" flow. The codes are only
 * shown to the user *once* — the wizard never lets them past this
 * screen until they confirm they've saved them, and the API never
 * returns them in plaintext again.
 */
export function BackupCodesPanel({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);

  const text = codes.join("\n");

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard might be blocked in incognito etc. — silent. */
    }
  };

  const onDownload = () => {
    // Leak nothing identifying via the filename — purely user-facing.
    const blob = new Blob([text + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "promptly-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 rounded-card border border-[var(--border)] bg-[var(--bg)] p-4 font-mono text-sm tracking-wider">
        {codes.map((c) => (
          <div key={c} className="select-all text-center">
            {c}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          onClick={onCopy}
          className="w-full justify-center"
        >
          {copied ? (
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5" />
              Copied
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Copy className="h-3.5 w-3.5" />
              Copy all
            </span>
          )}
        </Button>
        <Button
          variant="secondary"
          onClick={onDownload}
          className="w-full justify-center"
        >
          <span className="inline-flex items-center gap-1.5">
            <Download className="h-3.5 w-3.5" />
            Download
          </span>
        </Button>
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">
        These codes will not be shown again. Anyone who has them can sign in
        without your authenticator — keep them somewhere safe.
      </p>
    </div>
  );
}
