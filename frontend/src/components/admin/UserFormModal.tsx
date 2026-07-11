import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
  User as UserIcon,
  Users2,
} from "lucide-react";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { cn } from "@/utils/cn";
import { apiErrorMessage } from "@/utils/apiError";
import type { AdminModelOption, AdminUser, UserRole } from "@/api/types";
import type { UserGroup } from "@/api/groups";

export interface UserFormValues {
  email: string;
  username: string;
  password: string;
  role: UserRole;
  /** `null` = full access to the admin-curated pool. */
  allowed_models: string[] | null;
  /** Whether the user can use the `generate_image` chat tool. */
  can_generate_images: boolean;
  /** Group memberships (role bundles — grant connectors + models). */
  group_ids: string[];
  /**
   * Per-user quota overrides.
   * - `undefined` → omit from the request (server leaves unchanged).
   * - `null`      → revert to org-wide default.
   * - number      → explicit per-user cap.
   *
   * The form converts the empty input to `null` so saving with an
   * empty quota field reverts the user to whatever the org default
   * says.
   */
  storage_cap_bytes?: number | null;
  daily_token_budget?: number | null;
  monthly_token_budget?: number | null;
}

interface UserFormModalProps {
  open: boolean;
  mode: "create" | "edit";
  /** When editing, the current row (used for prefill + title). */
  user?: AdminUser | null;
  /** Admin's curated org-wide pool of models. */
  pool: AdminModelOption[];
  poolLoading: boolean;
  /** All groups, so the admin can drop the user into role bundles. */
  groups?: UserGroup[];
  onClose: () => void;
  /**
   * Commits the form. Resolve on success; throw to surface an error inline.
   * For edits, password is only included when the caller entered one.
   */
  onSubmit: (values: UserFormValues) => Promise<void>;
}

export function UserFormModal({
  open,
  mode,
  user,
  pool,
  poolLoading,
  groups = [],
  onClose,
  onSubmit,
}: UserFormModalProps) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [fullAccess, setFullAccess] = useState(true);
  const [canGenerateImages, setCanGenerateImages] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Quota fields stored as the strings the user types so an empty
  // input is distinguishable from "0" (which is a valid cap meaning
  // "this user gets nothing"). The submit handler folds these back
  // into number | null when shipping to the server.
  //
  // Storage is captured in GB with up to two decimal places — the
  // canonical unit for personal cloud caps (10 GB / 50 GB / 1 TB
  // all read naturally) while still letting an admin type "0.5" for
  // a 512 MB allocation without breaking out of the field's units.
  const [storageCapGb, setStorageCapGb] = useState("");
  const [dailyTokens, setDailyTokens] = useState("");
  const [monthlyTokens, setMonthlyTokens] = useState("");

  // Re-initialize whenever the modal is opened.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setSearch("");
    if (mode === "edit" && user) {
      setEmail(user.email);
      setUsername(user.username);
      setPassword("");
      setRole(user.role);
      setFullAccess(user.allowed_models === null);
      setCanGenerateImages(user.can_generate_images ?? true);
      setPicked(new Set(user.allowed_models ?? []));
      setGroupIds(new Set(user.group_ids ?? []));
      setStorageCapGb(
        user.storage_cap_bytes === null
          ? ""
          : formatGb(user.storage_cap_bytes)
      );
      setDailyTokens(
        user.daily_token_budget === null
          ? ""
          : String(user.daily_token_budget)
      );
      setMonthlyTokens(
        user.monthly_token_budget === null
          ? ""
          : String(user.monthly_token_budget)
      );
    } else {
      setEmail("");
      setUsername("");
      setPassword("");
      setRole("user");
      setFullAccess(true);
      setCanGenerateImages(true);
      setPicked(new Set());
      setGroupIds(new Set());
      setStorageCapGb("");
      setDailyTokens("");
      setMonthlyTokens("");
    }
  }, [open, mode, user]);

  const filteredPool = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter(
      (m) =>
        m.model_id.toLowerCase().includes(q) ||
        m.display_name.toLowerCase().includes(q) ||
        m.provider_name.toLowerCase().includes(q)
    );
  }, [pool, search]);

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setPicked(new Set(pool.map((m) => m.model_id)));
  const clearAll = () => setPicked(new Set());

  // Distinct models the selected groups contribute (union), for the hint.
  const groupModelCount = useMemo(() => {
    const ids = new Set<string>();
    for (const g of groups) {
      if (groupIds.has(g.id)) g.allowed_models.forEach((m) => ids.add(m));
    }
    return ids.size;
  }, [groups, groupIds]);

  const canSubmit =
    email.trim().length > 0 &&
    username.trim().length >= 3 &&
    (mode === "edit" || password.length >= 8);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setError(null);
    setBusy(true);

    // Quota inputs: empty string = revert to org default (`null`),
    // otherwise convert to int. NaN guards against typos like "abc".
    const parseQuota = (raw: string): number | null => {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = Math.floor(Number(trimmed));
      return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const storageBytes = parseGbToBytes(storageCapGb);

    try {
      await onSubmit({
        email: email.trim(),
        username: username.trim(),
        password,
        role,
        // Admins ignore the allowlist server-side, but we still send null
        // for UI clarity. Non-admin + full access → null; otherwise a list.
        allowed_models:
          role === "admin" || fullAccess ? null : Array.from(picked),
        can_generate_images: canGenerateImages,
        group_ids: Array.from(groupIds),
        storage_cap_bytes: storageBytes,
        daily_token_budget: parseQuota(dailyTokens),
        monthly_token_budget: parseQuota(monthlyTokens),
      });
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, "Request failed"));
    } finally {
      setBusy(false);
    }
  };

  const title = mode === "create" ? "Create user" : `Edit ${user?.username ?? "user"}`;
  const description =
    mode === "create"
      ? "Create a new account and choose which models they can use."
      : "Update this user's details. Leave password blank to keep it unchanged.";

  return (
    <Modal
      open={open}
      onClose={() => (busy ? undefined : onClose())}
      title={title}
      description={description}
      widthClass="max-w-2xl"
      dismissible={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={busy}
            disabled={!canSubmit}
          >
            {mode === "create" ? "Create user" : "Save changes"}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Identity */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <LabeledInput
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            required
            autoComplete="off"
          />
          <LabeledInput
            label="Username"
            value={username}
            onChange={setUsername}
            minLength={3}
            required
            autoComplete="off"
          />
        </div>
        <LabeledInput
          label={mode === "create" ? "Password" : "New password (optional)"}
          type="password"
          value={password}
          onChange={setPassword}
          minLength={mode === "create" ? 8 : undefined}
          required={mode === "create"}
          autoComplete="new-password"
          placeholder={mode === "edit" ? "Leave blank to keep unchanged" : undefined}
        />

        {/* Role toggle */}
        <div>
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Role
          </span>
          <div className="flex gap-2">
            <RoleOption
              active={role === "user"}
              onClick={() => setRole("user")}
              icon={<UserIcon className="h-4 w-4" />}
              title="User"
              body="Chat only. Model access limited to what you grant below."
            />
            <RoleOption
              active={role === "admin"}
              onClick={() => setRole("admin")}
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Admin"
              body="Full access. Can manage users and model providers."
            />
          </div>
        </div>

        {/* Quotas */}
        <div>
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
            Quotas
          </span>
          <p className="mb-2 text-[11px] text-[var(--text-muted)]">
            Leave a field blank to inherit the org-wide default. Enter
            0 to revoke without disabling. Storage is in gigabytes
            (decimals allowed, e.g. 0.5 for 512 MB); token budgets
            count prompt + completion tokens combined.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <LabeledInput
              label="Storage (GB)"
              type="number"
              value={storageCapGb}
              onChange={setStorageCapGb}
              min={0}
              step={0.1}
              placeholder="org default"
              autoComplete="off"
            />
            <LabeledInput
              label="Daily tokens"
              type="number"
              value={dailyTokens}
              onChange={setDailyTokens}
              min={0}
              placeholder="org default"
              autoComplete="off"
            />
            <LabeledInput
              label="Monthly tokens"
              type="number"
              value={monthlyTokens}
              onChange={setMonthlyTokens}
              min={0}
              placeholder="org default"
              autoComplete="off"
            />
          </div>
        </div>

        {/* Capabilities — hidden for admins (they're never gated) */}
        {role === "user" && (
          <div>
            <span className="mb-2 block text-xs font-medium text-[var(--text-muted)]">
              Capabilities
            </span>
            <label className="flex cursor-pointer items-start gap-2 rounded-card border border-[var(--border)] px-3 py-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={canGenerateImages}
                onChange={(e) => setCanGenerateImages(e.target.checked)}
              />
              <span className="text-xs">
                <span className="font-medium text-[var(--text)]">
                  Image generation
                </span>
                <span className="block text-[11px] text-[var(--text-muted)]">
                  Let this user ask the chat to generate or edit images. Off =
                  the image tool is withheld entirely for them.
                </span>
              </span>
            </label>
          </div>
        )}

        {/* Model access — hidden for admins */}
        {role === "user" && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--text-muted)]">
                Model access
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                {fullAccess
                  ? `All ${pool.length} available`
                  : `${picked.size} selected`}
              </span>
            </div>

            <div className="mb-2 flex gap-2">
              <AccessOption
                active={fullAccess}
                onClick={() => setFullAccess(true)}
                title="Full access"
                body="Every model the admin has curated."
              />
              <AccessOption
                active={!fullAccess}
                onClick={() => setFullAccess(false)}
                title="Custom"
                body="Pick specific models below."
              />
            </div>

            {!fullAccess && (
              <div className="rounded-card border border-[var(--border)]">
                <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
                  <Search className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                  <input
                    className="flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--text-muted)]"
                    placeholder="Search models"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <button
                    type="button"
                    className="text-[11px] text-[var(--accent)] hover:underline"
                    onClick={selectAll}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-[11px] text-[var(--text-muted)] hover:underline"
                    onClick={clearAll}
                  >
                    Clear
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto px-1 py-1">
                  {poolLoading && (
                    <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--text-muted)]">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading models...
                    </div>
                  )}
                  {!poolLoading && pool.length === 0 && (
                    <div className="px-2 py-3 text-xs text-[var(--text-muted)]">
                      No models available. Configure a provider in the Models page first.
                    </div>
                  )}
                  {!poolLoading &&
                    filteredPool.map((m) => {
                      const checked = picked.has(m.model_id);
                      return (
                        <label
                          key={`${m.provider_id}-${m.model_id}`}
                          className={cn(
                            "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs transition",
                            checked
                              ? "bg-[var(--accent)]/10"
                              : "hover:bg-[var(--hover)]"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(m.model_id)}
                            className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-[var(--text)]">
                              {m.display_name}
                            </div>
                            <div className="truncate text-[10px] text-[var(--text-muted)]">
                              {m.model_id} · {m.provider_name}
                              {m.context_window
                                ? ` · ${m.context_window.toLocaleString()} ctx`
                                : ""}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Groups (role bundles) — hidden for admins */}
        {role === "user" && groups.length > 0 && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--text-muted)]">
                Groups
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                {groupModelCount > 0
                  ? `+${groupModelCount} model${groupModelCount === 1 ? "" : "s"} granted`
                  : `${groupIds.size} selected`}
              </span>
            </div>
            <p className="mb-2 text-[11px] text-[var(--text-muted)]">
              A group grants its connectors and models to every member, on top
              of the access set above.
            </p>
            <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-card border border-[var(--border)] p-1">
              {groups.map((g) => {
                const checked = groupIds.has(g.id);
                return (
                  <label
                    key={g.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition",
                      checked ? "bg-[var(--accent)]/10" : "hover:bg-[var(--hover)]"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setGroupIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(g.id)) next.delete(g.id);
                          else next.add(g.id);
                          return next;
                        })
                      }
                      className="h-3.5 w-3.5 accent-[var(--accent)]"
                    />
                    <Users2 className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                    <span className="font-medium text-[var(--text)]">
                      {g.name}
                    </span>
                    {g.allowed_models.length > 0 && (
                      <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                        <Sparkles className="h-2.5 w-2.5" />
                        {g.allowed_models.length}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}

const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * Render a byte count as a GB string suitable for the input field.
 * - Whole GB values render without a trailing ".00" (e.g. "10", not "10.00").
 * - Sub-GB values round to two decimal places so the field doesn't
 *   display noise like "0.48828125" when the stored value is 500 MB.
 */
function formatGb(bytes: number): string {
  const gb = bytes / BYTES_PER_GB;
  if (gb === 0) return "0";
  const rounded = Math.round(gb * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Parse a GB string from the input field back into bytes.
 * - "" → null (revert to org-wide default).
 * - Anything non-numeric / negative also falls through to null so an
 *   accidental typo doesn't silently wipe a user's cap to 0.
 */
function parseGbToBytes(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * BYTES_PER_GB);
}

function LabeledInput({
  label,
  value,
  onChange,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
        {label}
      </span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]/60"
      />
    </label>
  );
}

function RoleOption({
  active,
  onClick,
  icon,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 flex-col gap-1 rounded-card border px-3 py-2.5 text-left transition",
        active
          ? "border-[var(--accent)]/60 bg-[var(--accent)]/10"
          : "border-[var(--border)] hover:bg-[var(--hover)]"
      )}
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </div>
      <span className="text-[11px] text-[var(--text-muted)]">{body}</span>
    </button>
  );
}

function AccessOption({
  active,
  onClick,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 flex-col gap-0.5 rounded-card border px-3 py-2 text-left transition",
        active
          ? "border-[var(--accent)]/60 bg-[var(--accent)]/10"
          : "border-[var(--border)] hover:bg-[var(--hover)]"
      )}
    >
      <span className="text-xs font-semibold">{title}</span>
      <span className="text-[10px] text-[var(--text-muted)]">{body}</span>
    </button>
  );
}
