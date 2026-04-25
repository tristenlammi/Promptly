import { useMemo, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Lock,
  Trash2,
  UserCheck,
} from "lucide-react";

import type {
  ShareAccessMode,
  ShareLink,
  ShareLinkCreatePayload,
} from "@/api/files";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import {
  useCreateFileShareLink,
  useCreateFolderShareLink,
  useFileShareLinks,
  useFolderShareLinks,
  useRevokeShareLink,
} from "@/hooks/useFiles";
import { cn } from "@/utils/cn";

import { extractError, formatRelativeTime } from "./helpers";

type Resource =
  | { kind: "file"; id: string; name: string }
  | { kind: "folder"; id: string; name: string };

interface ShareLinkDialogProps {
  open: boolean;
  resource: Resource | null;
  onClose: () => void;
}

type ExpiryChoice = "24h" | "7d" | "30d" | "never";

const EXPIRY_LABEL: Record<ExpiryChoice, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  never: "No expiry",
};

const EXPIRY_DAYS: Record<ExpiryChoice, number | null> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  never: null,
};

/**
 * Manages public share links for a file or folder.
 *
 * "Anyone with the link" (access_mode = public) — optional password,
 * optional expiry, anonymous visitors can open the landing page.
 * "Specific people" (access_mode = invite) — visitor must sign in;
 * the backend auto-adds them to an access list on first visit.
 *
 * Mirrors the UX shell of ``ShareConversationDialog`` but uses the
 * new ``file_share_links`` table (share tokens, not user-to-user
 * invites).
 */
export function ShareLinkDialog({ open, resource, onClose }: ShareLinkDialogProps) {
  const isFile = resource?.kind === "file";
  const fileId = isFile ? resource!.id : null;
  const folderId = resource && resource.kind === "folder" ? resource.id : null;

  const fileLinks = useFileShareLinks(fileId);
  const folderLinks = useFolderShareLinks(folderId);
  const data = isFile ? fileLinks.data : folderLinks.data;
  const isLoading = isFile ? fileLinks.isLoading : folderLinks.isLoading;

  const createFile = useCreateFileShareLink(fileId ?? "");
  const createFolder = useCreateFolderShareLink(folderId ?? "");
  const revoke = useRevokeShareLink();

  const [mode, setMode] = useState<ShareAccessMode>("public");
  const [expiry, setExpiry] = useState<ExpiryChoice>("7d");
  const [password, setPassword] = useState("");
  const [passwordOn, setPasswordOn] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const activeLinks = useMemo(
    () => (data?.links ?? []).filter((l) => !l.revoked_at),
    [data]
  );

  const handleCreate = async () => {
    if (!resource) return;
    setCreateError(null);
    const payload: ShareLinkCreatePayload = {
      access_mode: mode,
      password: passwordOn && password.trim() ? password : null,
      expires_in_days: EXPIRY_DAYS[expiry],
    };
    try {
      if (resource.kind === "file") {
        await createFile.mutateAsync(payload);
      } else {
        await createFolder.mutateAsync(payload);
      }
      setPassword("");
      setPasswordOn(false);
    } catch (e) {
      setCreateError(extractError(e));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={resource ? `Share "${resource.name}"` : "Share"}
      description={
        resource?.kind === "folder"
          ? "Anyone with the link can browse and download every file inside this folder."
          : undefined
      }
      widthClass="max-w-xl"
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-5">
        {/* Mode toggle — stacks on narrow viewports so each card's
            description stays readable. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ModeButton
            active={mode === "public"}
            onClick={() => setMode("public")}
            icon={<Globe className="h-4 w-4" />}
            title="Anyone with the link"
            description="Anonymous visitors can open the file."
          />
          <ModeButton
            active={mode === "invite"}
            onClick={() => setMode("invite")}
            icon={<UserCheck className="h-4 w-4" />}
            title="Specific people"
            description="Visitors must sign in. The first visit grants access."
          />
        </div>

        {/* Expiry — 2 columns on phones (labels wrap), 4 on tablet+. */}
        <div>
          <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
            Link expires
          </label>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {(Object.keys(EXPIRY_LABEL) as ExpiryChoice[]).map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => setExpiry(choice)}
                className={cn(
                  "rounded-md border px-2 py-2 text-xs font-medium transition",
                  expiry === choice
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
                )}
              >
                {EXPIRY_LABEL[choice]}
              </button>
            ))}
          </div>
        </div>

        {/* Password */}
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={passwordOn}
              onChange={(e) => setPasswordOn(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <Lock className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            <span>Require a password to unlock</span>
          </label>
          {passwordOn && (
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Choose a password"
              className="mt-2 w-full rounded-input border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
              autoComplete="new-password"
            />
          )}
        </div>

        {createError && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            {createError}
          </div>
        )}

        <div className="flex items-center justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={handleCreate}
            loading={createFile.isPending || createFolder.isPending}
            disabled={passwordOn && !password.trim()}
          >
            Create link
          </Button>
        </div>

        {/* Existing links */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Active links
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              {activeLinks.length}
            </div>
          </div>
          {isLoading && (
            <div className="text-sm text-[var(--text-muted)]">Loading…</div>
          )}
          {!isLoading && activeLinks.length === 0 && (
            <div className="rounded-md border border-dashed border-[var(--border)] px-3 py-4 text-center text-sm text-[var(--text-muted)]">
              No active links yet.
            </div>
          )}
          {activeLinks.map((link) => (
            <ShareLinkRow
              key={link.id}
              link={link}
              onRevoke={async () => revoke.mutateAsync(link.id)}
            />
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-start gap-2 rounded-md border p-3 text-left transition",
        active
          ? "border-[var(--accent)] bg-[var(--accent)]/10"
          : "border-[var(--border)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      )}
    >
      <div
        className={cn(
          "mt-0.5 shrink-0 rounded-md p-1.5",
          active
            ? "bg-[var(--accent)]/20 text-[var(--accent)]"
            : "bg-[var(--surface)] text-[var(--text-muted)]"
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[var(--text)]">{title}</div>
        <div className="text-xs text-[var(--text-muted)]">{description}</div>
      </div>
    </button>
  );
}

function ShareLinkRow({
  link,
  onRevoke,
}: {
  link: ShareLink;
  onRevoke: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const absoluteUrl = `${window.location.origin}${link.path}`;
  const expired =
    link.expires_at != null && new Date(link.expires_at).getTime() < Date.now();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — clipboard rejected */
    }
  };

  const revoke = async () => {
    setRevoking(true);
    try {
      await onRevoke();
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="mb-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="flex items-center gap-2">
        {link.access_mode === "public" ? (
          <Globe className="h-3.5 w-3.5 text-[var(--text-muted)]" />
        ) : (
          <UserCheck className="h-3.5 w-3.5 text-[var(--text-muted)]" />
        )}
        <span className="text-xs font-medium text-[var(--text)]">
          {link.access_mode === "public" ? "Anyone with link" : "Specific people"}
        </span>
        {link.has_password && (
          <span className="inline-flex items-center gap-1 rounded bg-[var(--surface)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
            <Lock className="h-3 w-3" /> Password
          </span>
        )}
        {expired && (
          <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
            Expired
          </span>
        )}
      </div>

      {/* Responsive link row: the URL input stacks above the action
          chips on phones so the full link stays readable — desktop
          keeps the compact single-row layout it already has. */}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-1">
        <input
          readOnly
          value={absoluteUrl}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 truncate rounded-input border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs text-[var(--text)]"
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            title="Copy link"
            aria-label="Copy link"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06] sm:h-7 sm:w-7"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          <a
            href={absoluteUrl}
            target="_blank"
            rel="noreferrer noopener"
            title="Open"
            aria-label="Open link"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06] sm:h-7 sm:w-7"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            onClick={revoke}
            disabled={revoking}
            title="Revoke link"
            aria-label="Revoke link"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-red-600 transition hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400 sm:h-7 sm:w-7"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-muted)]">
        <span>Created {formatRelativeTime(link.created_at)}</span>
        {link.expires_at && (
          <span>
            Expires{" "}
            {expired
              ? formatRelativeTime(link.expires_at)
              : `in ${countdownToExpiry(link.expires_at)}`}
          </span>
        )}
        <span>{link.access_count} opens</span>
      </div>
    </div>
  );
}

function countdownToExpiry(iso: string): string {
  const delta = new Date(iso).getTime() - Date.now();
  if (delta <= 0) return "0s";
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
