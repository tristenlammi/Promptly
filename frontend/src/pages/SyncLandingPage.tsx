import { useEffect, useState } from "react";
import { Download, Smartphone } from "lucide-react";
import { useSearchParams } from "react-router-dom";

/**
 * /sync?code=… — where a phone's camera lands after scanning the
 * "Add device" QR code. It needs no sign-in: the page only offers the
 * PromptlySync download (served by this server) and a way to hand the code
 * straight to the app if it's already installed. Pairing itself happens in
 * the app, which scans the same code.
 */

interface ApkInfo {
  version: string;
  size_bytes?: number;
}

const APK = "/downloads/PromptlySync.apk";

export function SyncLandingPage() {
  const [params] = useSearchParams();
  const code = params.get("code") ?? "";
  const [info, setInfo] = useState<ApkInfo | null | "missing">(null);

  useEffect(() => {
    let live = true;
    fetch("/downloads/PromptlySync.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: ApkInfo) => live && setInfo(j))
      .catch(() => live && setInfo("missing"));
    return () => {
      live = false;
    };
  }, []);

  const isAndroid = /android/i.test(navigator.userAgent);
  const openApp = code
    ? `promptlysync://pair?server=${encodeURIComponent(window.location.origin)}&code=${encodeURIComponent(code)}`
    : null;

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[var(--bg)] px-4 py-10">
      <div className="w-full max-w-sm rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 text-center shadow-sm">
        <Smartphone className="mx-auto mb-3 h-10 w-10 text-[var(--accent)]" />
        <h1 className="text-lg font-semibold text-[var(--text)]">PromptlySync</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Backs up your phone's photos and videos to Promptly, in the background.
        </p>

        {info === "missing" ? (
          <p className="mt-5 rounded-md border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-muted)]">
            The app isn't available on this server yet. Ask whoever runs it to update Promptly.
          </p>
        ) : (
          <>
            <a
              href={APK}
              download="PromptlySync.apk"
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              Download for Android
            </a>
            {typeof info === "object" && info && (
              <p className="mt-1.5 text-xs text-[var(--text-muted)]">
                Version {info.version}
                {info.size_bytes ? ` · ${(info.size_bytes / 1048576).toFixed(1)} MB` : ""}
              </p>
            )}
          </>
        )}

        <ol className="mt-5 list-decimal space-y-1.5 pl-5 text-left text-sm text-[var(--text)]">
          <li>Download and open the file. If Android asks, allow installing from your browser.</li>
          <li>Open PromptlySync and scan the QR code on your computer again.</li>
          <li>Choose the folders to back up — syncing starts right away.</li>
        </ol>

        {openApp && isAndroid && (
          <a href={openApp} className="mt-4 block text-sm text-[var(--accent-text)] hover:underline">
            Already installed? Open PromptlySync
          </a>
        )}
        {!isAndroid && (
          <p className="mt-4 text-xs text-[var(--text-muted)]">PromptlySync is for Android phones.</p>
        )}
      </div>
    </div>
  );
}
