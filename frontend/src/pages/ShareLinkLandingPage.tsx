import { useCallback, useEffect, useState } from "react";
import {
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  File as FileIcon,
  FileText,
  Folder as FolderIcon,
  Image as ImageIcon,
  Loader2,
  Lock,
  LogIn,
} from "lucide-react";

import {
  type FileItem,
  type FolderItem,
  type ShareFolderBrowseResponse,
  type ShareLinkMeta,
} from "@/api/files";
import { shareApi } from "@/api/share";
import { Button } from "@/components/shared/Button";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

import { humanSize } from "@/components/files/helpers";

/**
 * Anonymous-friendly landing page mounted at ``/s/:token`` (OUTSIDE
 * ``AppLayout``). Hits the ``/api/s`` public router for metadata,
 * optional password unlock, download, and folder browsing.
 *
 * We deliberately don't render the main Promptly sidebar here — a
 * visitor who received a link shouldn't see chat nav, user
 * settings, or an invitation to log in unless the backend asks for
 * it.
 */
export function ShareLinkLandingPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAuthed = useAuthStore((s) => !!s.accessToken);

  const [meta, setMeta] = useState<ShareLinkMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<
    "loading" | "locked" | "ready" | "error" | "login_required"
  >("loading");
  const [unlockToken, setUnlockToken] = useState<string | null>(null);

  // Pull ``?unlock=`` from the URL so refreshing the page doesn't
  // drop the just-entered password. We write to sessionStorage in
  // addition so anyone clicking "back / forward" keeps the unlock
  // state for the duration of the tab session but never beyond it.
  useEffect(() => {
    if (!token) return;
    const qp = searchParams.get("unlock");
    const saved = sessionStorage.getItem(`share-unlock:${token}`);
    setUnlockToken(qp ?? saved ?? null);
  }, [token, searchParams]);

  const loadMeta = useCallback(
    async (currentUnlock: string | null) => {
      if (!token) return;
      setStatus("loading");
      setError(null);
      try {
        const m = await shareApi.meta(token, currentUnlock);
        setMeta(m);
        if (m.requires_auth && !isAuthed) {
          setStatus("login_required");
        } else if (m.requires_password) {
          setStatus("locked");
        } else {
          setStatus("ready");
        }
      } catch (e) {
        setError(extractHttpError(e));
        setStatus("error");
      }
    },
    [token, isAuthed]
  );

  useEffect(() => {
    void loadMeta(unlockToken);
  }, [loadMeta, unlockToken]);

  const handleUnlock = async (password: string) => {
    if (!token) return;
    try {
      const { unlock_token } = await shareApi.unlock(token, password);
      sessionStorage.setItem(`share-unlock:${token}`, unlock_token);
      setSearchParams((p) => {
        p.set("unlock", unlock_token);
        return p;
      });
      setUnlockToken(unlock_token);
      await loadMeta(unlock_token);
    } catch (e) {
      throw new Error(extractHttpError(e));
    }
  };

  if (!token) {
    return (
      <Chrome>
        <EmptyState
          icon={<AlertTriangle className="h-6 w-6" />}
          title="Invalid link"
          description="The URL doesn't look like a share link."
        />
      </Chrome>
    );
  }

  if (status === "loading") {
    return (
      <Chrome>
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </Chrome>
    );
  }

  if (status === "error") {
    return (
      <Chrome>
        <EmptyState
          icon={<AlertTriangle className="h-6 w-6" />}
          title="This link isn't available"
          description={error ?? "The share link may have been revoked or expired."}
        />
      </Chrome>
    );
  }

  if (status === "login_required") {
    return (
      <Chrome>
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 text-center shadow-sm">
          <LogIn className="mx-auto mb-3 h-6 w-6 text-[var(--accent)]" />
          <h1 className="text-base font-semibold">Sign in to continue</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            This link requires a Promptly account. Sign in to access it.
          </p>
          <Button
            className="mt-4"
            variant="primary"
            size="sm"
            onClick={() =>
              navigate(`/login?next=${encodeURIComponent(`/s/${token}`)}`)
            }
          >
            Sign in
          </Button>
        </div>
      </Chrome>
    );
  }

  if (status === "locked") {
    return (
      <Chrome>
        <PasswordForm meta={meta!} onSubmit={handleUnlock} />
      </Chrome>
    );
  }

  if (meta?.resource_type === "folder") {
    return (
      <Chrome wide>
        <FolderViewer
          token={token}
          meta={meta}
          unlockToken={unlockToken}
        />
      </Chrome>
    );
  }

  if (meta?.resource_type === "file") {
    return (
      <Chrome>
        <FileCard token={token} meta={meta} unlockToken={unlockToken} />
      </Chrome>
    );
  }

  return null;
}

// ----------------------------------------------------------------
// Password unlock
// ----------------------------------------------------------------
function PasswordForm({
  meta,
  onSubmit,
}: {
  meta: ShareLinkMeta;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(password);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-sm rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm"
    >
      <Lock className="mx-auto mb-3 h-6 w-6 text-[var(--accent)]" />
      <h1 className="text-center text-base font-semibold">Password required</h1>
      <p className="mt-1 text-center text-sm text-[var(--text-muted)]">
        This {meta.resource_type} is protected by a password.
      </p>
      <label className="mt-4 block text-sm">
        <span className="mb-1 block text-[var(--text-muted)]">Password</span>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
        />
      </label>
      {err && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{err}</p>
      )}
      <Button
        type="submit"
        variant="primary"
        size="sm"
        className="mt-4 w-full"
        loading={busy}
        disabled={!password}
      >
        Unlock
      </Button>
    </form>
  );
}

// ----------------------------------------------------------------
// File landing — metadata card + preview + download
// ----------------------------------------------------------------
function FileCard({
  token,
  meta,
  unlockToken,
}: {
  token: string;
  meta: ShareLinkMeta;
  unlockToken: string | null;
}) {
  const [downloading, setDownloading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hasFile = !!meta.filename;

  const handleDownload = async () => {
    setDownloading(true);
    setErr(null);
    try {
      const blob = await shareApi.downloadBlob(token, { unlockToken });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = meta.filename ?? "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setErr(extractHttpError(e));
    } finally {
      setDownloading(false);
    }
  };

  if (!hasFile) return null;

  return (
    <>
      <div className="w-full max-w-md rounded-card border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <FileLandingIcon mime={meta.mime_type ?? ""} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold" title={meta.filename ?? ""}>
              {meta.filename}
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              {humanSize(meta.size_bytes ?? 0)}
              {meta.mime_type ? ` · ${meta.mime_type}` : ""}
            </div>
          </div>
        </div>

        {err && (
          <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {err}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={() => setPreviewOpen(true)}
          >
            Preview
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            leftIcon={<Download className="h-3.5 w-3.5" />}
            loading={downloading}
            onClick={handleDownload}
          >
            Download
          </Button>
        </div>
      </div>

      {/* Preview uses a shim FileItem + the public download URL.
          The modal accepts a downloadUrl via filesApi internally —
          we work around that by fetching the blob ourselves when
          the modal mounts. Since the share landing page isn't the
          same authenticated scope, we wrap the preview in our own
          blob bootstrap. */}
      {previewOpen && (
        <PublicFilePreview
          token={token}
          meta={meta}
          unlockToken={unlockToken}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  );
}

// Share-link preview uses the same ``FilePreviewModal`` but we have
// to intercept the download URL so it goes through ``/api/s/...``
// rather than ``/api/files/...``. We do that by injecting a custom
// ``FileItem`` whose id is the share token — then the modal's
// image/pdf/text loaders hit an alternative fetch chain.
function PublicFilePreview({
  token,
  meta,
  unlockToken,
  onClose,
}: {
  token: string;
  meta: ShareLinkMeta;
  unlockToken: string | null;
  onClose: () => void;
}) {
  // We build an absolute blob URL here rather than relying on the
  // modal's internal fetch logic, because that logic goes through
  // the authenticated ``apiClient`` and the public share endpoints
  // don't live under ``/api/files``.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    (async () => {
      try {
        const blob = await shareApi.downloadBlob(token, { unlockToken });
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      } catch (e) {
        if (!revoked) setErr(extractHttpError(e));
      }
    })();
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [token, unlockToken]);

  if (err) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {err}
        </div>
        <button
          className="absolute right-4 top-4 rounded-md bg-black/50 px-3 py-1 text-sm text-white"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 text-sm text-white/70">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading preview…
      </div>
    );
  }

  return (
    <PublicBlobPreview
      filename={meta.filename ?? "file"}
      mime={meta.mime_type ?? ""}
      blobUrl={blobUrl}
      onClose={onClose}
    />
  );
}

// Thin viewer for an already-resolved blob URL — images get an
// ``<img>``, PDFs an ``<iframe>``, text a readable scroll. We don't
// attempt code highlighting here to keep the landing page bundle
// small.
function PublicBlobPreview({
  filename,
  mime,
  blobUrl,
  onClose,
}: {
  filename: string;
  mime: string;
  blobUrl: string;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);

  const isImage = mime.startsWith("image/");
  const isPdf = mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
  const isText = !isImage && !isPdf && (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    /\.(txt|md|json|xml|csv|log|yaml|yml|toml|ini)$/i.test(filename)
  );

  useEffect(() => {
    if (!isText) return;
    let cancelled = false;
    fetch(blobUrl)
      .then((r) => r.text())
      .then((t) => {
        if (!cancelled) setText(t.length > 512 * 1024 ? t.slice(0, 512 * 1024) : t);
      })
      .catch(() => setText(null));
    return () => {
      cancelled = true;
    };
  }, [blobUrl, isText]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-white/10 bg-black/40 px-4 py-2.5 text-white">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={filename}>
            {filename}
          </div>
          <div className="truncate text-[11px] text-white/60">
            {mime || "unknown"}
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-md px-3 py-1 text-sm text-white/80 hover:bg-white/10 hover:text-white"
        >
          Close
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        {isImage && (
          <img
            src={blobUrl}
            alt={filename}
            className="max-h-full max-w-full rounded-md shadow-2xl"
            draggable={false}
          />
        )}
        {isPdf && (
          <iframe
            src={blobUrl}
            title={filename}
            className="h-full w-full rounded-md border-0 bg-white shadow-2xl"
          />
        )}
        {isText && (
          <div className="h-full w-full max-w-4xl overflow-y-auto rounded-md bg-[var(--bg)] px-5 py-4 text-[var(--text)] shadow-2xl">
            <pre className="whitespace-pre-wrap break-words text-sm">
              {text ?? ""}
            </pre>
          </div>
        )}
        {!isImage && !isPdf && !isText && (
          <div className="rounded-md border border-white/20 bg-white/10 p-6 text-center text-white">
            <p className="text-sm">
              No inline preview available for this file type.
            </p>
            <a
              href={blobUrl}
              download={filename}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white"
            >
              <Download className="h-3.5 w-3.5" /> Download
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// Folder landing — browse descendants + per-file download
// ----------------------------------------------------------------
function FolderViewer({
  token,
  meta,
  unlockToken,
}: {
  token: string;
  meta: ShareLinkMeta;
  unlockToken: string | null;
}) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [data, setData] = useState<ShareFolderBrowseResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<FileItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    shareApi
      .browse(token, folderId, unlockToken)
      .then((resp) => {
        if (!cancelled) {
          setData(resp);
        }
      })
      .catch((e) => {
        if (!cancelled) setErr(extractHttpError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, folderId, unlockToken]);

  // File preview uses the dedicated share file endpoint.
  const previewFile = async (file: FileItem) => {
    setPreview(file);
  };

  const downloadShareFile = async (file: FileItem) => {
    try {
      const blob = await shareApi.downloadBlob(token, {
        fileId: file.id,
        unlockToken,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setErr(extractHttpError(e));
    }
  };

  return (
    <div className="w-full max-w-5xl">
      <div className="mb-3 flex items-center gap-2">
        <FolderIcon className="h-5 w-5 text-[var(--accent)]" />
        <h1 className="truncate text-base font-semibold">{meta.filename}</h1>
      </div>

      {data && (
        <Breadcrumbs
          crumbs={data.breadcrumbs}
          onNavigate={(id) => setFolderId(id)}
        />
      )}

      {err && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {err}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {data && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--surface)]">
          <ul className="divide-y divide-[var(--border)]">
            {data.folders.map((f) => (
              <SharedFolderRow
                key={f.id}
                folder={f}
                onOpen={() => setFolderId(f.id)}
              />
            ))}
            {data.files.map((f) => (
              <SharedFileRow
                key={f.id}
                file={f}
                onPreview={() => previewFile(f)}
                onDownload={() => downloadShareFile(f)}
              />
            ))}
            {data.folders.length === 0 && data.files.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-[var(--text-muted)]">
                This folder is empty.
              </li>
            )}
          </ul>
        </div>
      )}

      {preview && (
        <SharedFilePreviewModal
          token={token}
          file={preview}
          unlockToken={unlockToken}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

function Breadcrumbs({
  crumbs,
  onNavigate,
}: {
  crumbs: { id: string | null; name: string }[];
  onNavigate: (id: string | null) => void;
}) {
  return (
    <nav className="mb-3 flex items-center gap-1 text-sm text-[var(--text-muted)]">
      {crumbs.map((c, i) => (
        <span key={`${c.id ?? "root"}-${i}`} className="inline-flex items-center gap-1">
          {i > 0 && <ArrowLeft className="hidden h-3 w-3 rotate-180 md:inline" />}
          {i === crumbs.length - 1 ? (
            <span className="font-medium text-[var(--text)]">{c.name}</span>
          ) : (
            <button
              onClick={() => onNavigate(c.id)}
              className="rounded px-1.5 py-1 hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
            >
              {c.name}
            </button>
          )}
          {i < crumbs.length - 1 && <span className="text-[var(--text-muted)]">/</span>}
        </span>
      ))}
    </nav>
  );
}

function SharedFolderRow({
  folder,
  onOpen,
}: {
  folder: FolderItem;
  onOpen: () => void;
}) {
  return (
    <li className="group flex items-center gap-3 px-4 py-3 transition hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <FolderIcon className="h-5 w-5 shrink-0 text-[var(--accent)]" />
        <span className="truncate text-sm font-medium">{folder.name}</span>
      </button>
    </li>
  );
}

function SharedFileRow({
  file,
  onPreview,
  onDownload,
}: {
  file: FileItem;
  onPreview: () => void;
  onDownload: () => void;
}) {
  return (
    <li
      className="group flex items-center gap-3 px-4 py-3 transition hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
      onDoubleClick={onPreview}
    >
      <button
        onClick={onPreview}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <FileLandingIcon mime={file.mime_type} />
        <div className="min-w-0">
          <div className="truncate text-sm">{file.filename}</div>
          <div className="text-xs text-[var(--text-muted)]">
            {humanSize(file.size_bytes)} · {file.mime_type || "unknown"}
          </div>
        </div>
      </button>
      <button
        onClick={onDownload}
        title="Download"
        aria-label={`Download ${file.filename}`}
        className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
      >
        <Download className="h-4 w-4" />
      </button>
    </li>
  );
}

function SharedFilePreviewModal({
  token,
  file,
  unlockToken,
  onClose,
}: {
  token: string;
  file: FileItem;
  unlockToken: string | null;
  onClose: () => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      try {
        const blob = await shareApi.downloadBlob(token, {
          fileId: file.id,
          unlockToken,
        });
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      } catch (e) {
        if (!cancelled) setErr(extractHttpError(e));
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [token, file.id, unlockToken]);

  if (err) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {err}
        </div>
        <button
          className="absolute right-4 top-4 rounded-md bg-black/50 px-3 py-1 text-sm text-white"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 text-sm text-white/70">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading preview…
      </div>
    );
  }

  return (
    <PublicBlobPreview
      filename={file.filename}
      mime={file.mime_type}
      blobUrl={blobUrl}
      onClose={onClose}
    />
  );
}

// ----------------------------------------------------------------
// Chrome
// ----------------------------------------------------------------
function Chrome({
  children,
  wide,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)]">
        <div
          className={cn(
            "mx-auto flex items-center gap-2 px-4 py-3",
            wide ? "max-w-5xl" : "max-w-3xl"
          )}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--accent)] text-white">
            <span className="text-sm font-bold">P</span>
          </div>
          <div className="text-sm font-semibold tracking-tight">
            Promptly Drive
          </div>
        </div>
      </header>
      <main
        className={cn(
          "mx-auto flex min-h-[calc(100vh-3rem)] items-center justify-center px-4 py-8",
          wide ? "max-w-5xl" : "max-w-3xl"
        )}
      >
        {children}
      </main>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="text-center">
      <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface)] text-[var(--text-muted)]">
        {icon}
      </div>
      <h1 className="text-base font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>
    </div>
  );
}

function FileLandingIcon({ mime }: { mime: string }) {
  if (mime.startsWith("image/")) {
    return <ImageIcon className="h-10 w-10 shrink-0 text-violet-500" />;
  }
  if (mime.startsWith("text/") || mime === "application/json") {
    return <FileText className="h-10 w-10 shrink-0 text-sky-500" />;
  }
  return <FileIcon className="h-10 w-10 shrink-0 text-[var(--text-muted)]" />;
}

function extractHttpError(e: unknown): string {
  if (typeof e === "object" && e && "response" in e) {
    const resp = (e as { response?: { data?: { detail?: unknown }; status?: number } }).response;
    const detail = resp?.data?.detail;
    if (typeof detail === "string") return detail;
    if (resp?.status === 401) return "Password required.";
    if (resp?.status === 404) return "Share link not found.";
    if (resp?.status === 410) return "This share link is no longer active.";
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
