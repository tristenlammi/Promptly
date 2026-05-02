import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy as CopyIcon,
  Eye,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Users,
} from "lucide-react";

import {
  filesApi,
  MAX_GRANTS_PER_RESOURCE,
  type Grantee,
  type ShareableResourceType,
  type UserSearchHit,
} from "@/api/files";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";

import { extractError } from "./helpers";

interface ShareGrantsModalProps {
  open: boolean;
  resource: {
    type: ShareableResourceType;
    id: string;
    name: string;
    /** When ``true`` the resource accepts ``can_edit=true`` grants
     *  (Drive Documents only). Folders and non-document files
     *  hide the Editor option in the role picker so users don't
     *  hit a backend 400. */
    supports_edit?: boolean;
  } | null;
  onClose: () => void;
  /** Called with the latest list whenever a grant is added,
   *  updated, or revoked so the parent can invalidate query
   *  caches and refresh the row's pill without a refetch. */
  onChanged?: () => void;
}

/** Three mutually-exclusive permission tiers exposed to the
 *  share-modal user. Internally each tier maps to the
 *  ``can_copy`` + ``can_edit`` boolean pair the backend stores —
 *  keeping that mapping in one place stops the UI and the API
 *  drifting apart. */
type Role = "viewer" | "viewer_copy" | "editor";

function roleFromGrant(g: Pick<Grantee, "can_copy" | "can_edit">): Role {
  if (g.can_edit) return "editor";
  if (g.can_copy) return "viewer_copy";
  return "viewer";
}

function flagsFromRole(role: Role): { can_copy: boolean; can_edit: boolean } {
  switch (role) {
    case "editor":
      return { can_copy: false, can_edit: true };
    case "viewer_copy":
      return { can_copy: true, can_edit: false };
    case "viewer":
    default:
      return { can_copy: false, can_edit: false };
  }
}

/** Drive-stage-5 share modal — peer-to-peer grants.
 *
 *  Three regions:
 *
 *  1. Header explaining what this share does (different from the
 *     URL-based ShareLinkDialog so users aren't confused).
 *  2. Picker: debounced username/email autocomplete + can_copy
 *     toggle. Adding a user issues a POST and the new row appears
 *     in the list below.
 *  3. List of current grantees with a per-row can_copy toggle and
 *     revoke button. ``(N/10)`` counter visible at all times so
 *     the cap is obvious.
 */
export function ShareGrantsModal({
  open,
  resource,
  onClose,
  onChanged,
}: ShareGrantsModalProps) {
  const [grants, setGrants] = useState<Grantee[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Picker state
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** The role applied to the *next* user added from the picker.
   *  Per-grantee changes happen on the row itself further down. */
  const [defaultRole, setDefaultRole] = useState<Role>("viewer");
  const [adding, setAdding] = useState(false);

  const supportsEdit = resource?.supports_edit ?? false;

  // "Stop sharing" inline confirm — we deliberately don't stack
  // another <Modal> on top of this one (focus-trap nightmare) and
  // instead swap in an inline banner near the footer.
  const [confirmUnshare, setConfirmUnshare] = useState(false);
  const [unsharing, setUnsharing] = useState(false);

  // Reset everything when the modal opens against a new resource.
  useEffect(() => {
    if (!open || !resource) {
      setGrants([]);
      setError(null);
      setQuery("");
      setResults([]);
      setConfirmUnshare(false);
      setUnsharing(false);
      setDefaultRole("viewer");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    filesApi
      .listGrants(resource.type, resource.id)
      .then((res) => {
        if (cancelled) return;
        setGrants(res.grants);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(extractError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, resource]);

  // Debounced user search. The picker only fires after 200ms of
  // inactivity and at least 1 character — keeps the autocomplete
  // feel snappy without flooding the backend on every keystroke.
  const searchTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !resource) return;
    if (searchTimer.current) {
      window.clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    if (!query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = window.setTimeout(async () => {
      try {
        const res = await filesApi.searchUsersForShare(query.trim(), {
          type: resource.type,
          id: resource.id,
        });
        setResults(res.results);
      } catch (e) {
        setError(extractError(e));
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => {
      if (searchTimer.current) {
        window.clearTimeout(searchTimer.current);
        searchTimer.current = null;
      }
    };
  }, [query, open, resource]);

  const grantedIds = useMemo(
    () => new Set(grants.map((g) => g.user_id)),
    [grants]
  );

  const atCap = grants.length >= MAX_GRANTS_PER_RESOURCE;

  const handleAdd = async (user: UserSearchHit) => {
    if (!resource || adding) return;
    if (atCap) {
      setError(
        `You can only share with up to ${MAX_GRANTS_PER_RESOURCE} people at once.`
      );
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const flags = flagsFromRole(defaultRole);
      const res = await filesApi.createGrant(resource.type, resource.id, {
        grantee_user_id: user.id,
        can_copy: flags.can_copy,
        can_edit: flags.can_edit,
      });
      setGrants(res.grants);
      setQuery("");
      setResults([]);
      setPickerOpen(false);
      onChanged?.();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setAdding(false);
    }
  };

  /** Apply a new role to an existing grant. We always send both
   *  flags so a switch from "Editor" → "Viewer + copy" doesn't
   *  leave ``can_edit`` stuck at true on the row. */
  const handleSetRole = async (g: Grantee, role: Role) => {
    if (!resource) return;
    if (roleFromGrant(g) === role) return;
    setError(null);
    try {
      const flags = flagsFromRole(role);
      const res = await filesApi.updateGrant(
        resource.type,
        resource.id,
        g.grant_id,
        { can_copy: flags.can_copy, can_edit: flags.can_edit }
      );
      setGrants(res.grants);
      onChanged?.();
    } catch (e) {
      setError(extractError(e));
    }
  };

  const handleRevoke = async (g: Grantee) => {
    if (!resource) return;
    setError(null);
    try {
      const res = await filesApi.revokeGrant(
        resource.type,
        resource.id,
        g.grant_id
      );
      setGrants(res.grants);
      onChanged?.();
    } catch (e) {
      setError(extractError(e));
    }
  };

  const handleUnshareAll = async () => {
    if (!resource || unsharing) return;
    setUnsharing(true);
    setError(null);
    try {
      const res = await filesApi.revokeAllGrants(resource.type, resource.id);
      setGrants(res.grants);
      setConfirmUnshare(false);
      onChanged?.();
    } catch (e) {
      setError(extractError(e));
    } finally {
      setUnsharing(false);
    }
  };

  if (!resource) return null;

  return (
    <Modal open={open} onClose={onClose} widthClass="max-w-xl">
      <div className="space-y-4">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text)]">
              <Users className="h-5 w-5 text-[var(--accent)]" />
              <span>Share {resource.type === "folder" ? "folder" : "file"}</span>
            </h2>
            <p className="mt-0.5 truncate text-sm text-[var(--text-muted)]">
              {resource.name}
            </p>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-1 text-xs font-medium",
              atCap
                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                : "bg-[var(--accent)]/10 text-[var(--accent)]"
            )}
          >
            {grants.length}/{MAX_GRANTS_PER_RESOURCE}
          </span>
        </header>

        <p className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]">
          Picked users see this {resource.type} in their <strong>Shared</strong>{" "}
          tab. Pick their access level: <strong>Viewer</strong> (read-only),{" "}
          <strong>Viewer + copy</strong> (can save a copy into their own
          Drive){supportsEdit ? (
            <>
              , or <strong>Editor</strong> (real-time co-editing — your
              original stays a live shared doc)
            </>
          ) : null}
          . Your original is never overwritten by a copy. Need a public URL
          instead? Use the link-share button.
        </p>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Picker */}
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-3">
          <label className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]">
            <Search className="h-3.5 w-3.5" />
            <span>Add by username or email</span>
          </label>
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              atCap ? "Cap reached — revoke before adding" : "alice or alice@…"
            }
            disabled={atCap || adding}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPickerOpen(true);
            }}
            onFocus={() => setPickerOpen(true)}
            className={cn(
              "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm",
              "outline-none focus:border-[var(--accent)]",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          />
          <div className="mt-2 flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
              Default role
            </span>
            <RolePicker
              value={defaultRole}
              onChange={setDefaultRole}
              supportsEdit={supportsEdit}
              disabled={atCap || adding}
              size="sm"
            />
          </div>
          {pickerOpen && query.trim().length > 0 && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface)]">
              {searching && (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-muted)]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Searching…</span>
                </div>
              )}
              {!searching && results.length === 0 && (
                <div className="px-3 py-2 text-xs text-[var(--text-muted)]">
                  No matches.
                </div>
              )}
              {!searching &&
                results.map((u) => {
                  const already =
                    u.already_granted || grantedIds.has(u.id);
                  return (
                    <button
                      key={u.id}
                      type="button"
                      disabled={already || adding || atCap}
                      onClick={() => handleAdd(u)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition",
                        already
                          ? "cursor-not-allowed opacity-60"
                          : "hover:bg-[var(--bg)]"
                      )}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-[var(--text)]">
                          @{u.username}
                        </div>
                        {u.email && (
                          <div className="truncate text-xs text-[var(--text-muted)]">
                            {u.email}
                          </div>
                        )}
                      </div>
                      {already ? (
                        <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                          Already added
                        </span>
                      ) : (
                        <span className="shrink-0 text-xs text-[var(--accent)]">
                          + Add
                        </span>
                      )}
                    </button>
                  );
                })}
            </div>
          )}
        </div>

        {/* Current grantees */}
        <div className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            People with access
          </h3>
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg)]">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-[var(--text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading…</span>
              </div>
            )}
            {!loading && grants.length === 0 && (
              <div className="px-3 py-3 text-sm text-[var(--text-muted)]">
                Nobody yet. Search above to add a teammate.
              </div>
            )}
            {!loading &&
              grants.map((g) => (
                <div
                  key={g.grant_id}
                  className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-3 py-2 first:border-t-0"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[var(--text)]">
                      @{g.username}
                    </div>
                    {g.email && (
                      <div className="truncate text-xs text-[var(--text-muted)]">
                        {g.email}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <RolePicker
                      value={roleFromGrant(g)}
                      onChange={(r) => void handleSetRole(g, r)}
                      supportsEdit={supportsEdit}
                      size="xs"
                    />
                    <button
                      type="button"
                      onClick={() => void handleRevoke(g)}
                      title="Revoke access"
                      aria-label="Revoke access"
                      className={cn(
                        "rounded-md p-1.5 text-[var(--text-muted)] transition",
                        "hover:bg-rose-500/10 hover:text-rose-500"
                      )}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* Inline "stop sharing" confirmation. Rendered as a banner
            rather than a nested modal so focus + keyboard flow stays
            in this sheet. Appears only after the user explicitly
            asks for it, so the regular Done button is still reachable
            in the common case. */}
        {confirmUnshare && (
          <div className="flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-400">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                Stop sharing with everyone?
              </p>
              <p className="mt-0.5 text-xs text-rose-700/80 dark:text-rose-400/80">
                Access will be revoked for {grants.length}{" "}
                {grants.length === 1 ? "person" : "people"}. They&rsquo;ll
                no longer see this {resource.type} in their Shared tab.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmUnshare(false)}
                  disabled={unsharing}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void handleUnshareAll()}
                  loading={unsharing}
                  leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                >
                  Yes, stop sharing
                </Button>
              </div>
            </div>
          </div>
        )}

        <footer className="flex items-center justify-between gap-2 pt-1">
          {grants.length > 0 && !confirmUnshare ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmUnshare(true)}
              leftIcon={<Trash2 className="h-4 w-4" />}
              className="text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
            >
              Stop sharing
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" onClick={onClose} disabled={unsharing}>
            <Check className="h-4 w-4" />
            <span>Done</span>
          </Button>
        </footer>
      </div>
    </Modal>
  );
}


// --------------------------------------------------------------------
// Role picker — three-segment toggle shared by the picker + each row.
// --------------------------------------------------------------------
interface RolePickerProps {
  value: Role;
  onChange: (next: Role) => void;
  /** ``true`` only on Drive Documents — folders & non-doc files
   *  hide the Editor option (the backend rejects ``can_edit=true``
   *  for them so we don't even render it). */
  supportsEdit: boolean;
  disabled?: boolean;
  /** ``"sm"`` for the picker header, ``"xs"`` for compact rows. */
  size?: "xs" | "sm";
}

function RolePicker({
  value,
  onChange,
  supportsEdit,
  disabled = false,
  size = "sm",
}: RolePickerProps) {
  const items: Array<{
    role: Role;
    label: string;
    title: string;
    icon: JSX.Element;
  }> = [
    {
      role: "viewer",
      label: "Viewer",
      title: "Read-only access — preview and download.",
      icon: <Eye className="h-3 w-3" />,
    },
    {
      role: "viewer_copy",
      label: "Viewer + copy",
      title:
        "Read-only access plus the ability to save a copy into their own Drive.",
      icon: <CopyIcon className="h-3 w-3" />,
    },
  ];
  if (supportsEdit) {
    items.push({
      role: "editor",
      label: "Editor",
      title:
        "Real-time collaborative editing. They see live cursors and their changes save back to your file.",
      icon: <Pencil className="h-3 w-3" />,
    });
  }

  const padX = size === "xs" ? "px-2" : "px-2.5";
  const padY = size === "xs" ? "py-0.5" : "py-1";

  return (
    <div
      role="radiogroup"
      aria-label="Access level"
      className={cn(
        "inline-flex shrink-0 items-stretch overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg)]",
        disabled && "opacity-60"
      )}
    >
      {items.map((item, idx) => {
        const selected = value === item.role;
        return (
          <button
            key={item.role}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(item.role)}
            title={item.title}
            className={cn(
              "inline-flex items-center gap-1 text-xs transition",
              padX,
              padY,
              idx > 0 && "border-l border-[var(--border)]",
              selected
                ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                : "text-[var(--text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
              disabled && "cursor-not-allowed"
            )}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
