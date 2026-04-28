import { forwardRef, useEffect, useRef, useState } from "react";
import {
  Ban,
  BarChart3,
  CheckCircle2,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  MoreHorizontal,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Unlock,
  User as UserIcon,
} from "lucide-react";
import { createPortal } from "react-dom";

import { DeleteUserModal } from "@/components/admin/DeleteUserModal";
import { ResetPasswordModal } from "@/components/admin/ResetPasswordModal";
import { UserUsageModal } from "@/components/admin/UserUsageModal";
import {
  UserFormModal,
  type UserFormValues,
} from "@/components/admin/UserFormModal";
import { Button } from "@/components/shared/Button";
import {
  useAdminModelPool,
  useAdminUsers,
  useCreateAdminUser,
  useDeleteAdminUser,
  useDisableUser,
  useEnableUser,
  useLogoutEverywhere,
  useResetUserPassword,
  useUnlockUser,
  useUpdateAdminUser,
} from "@/hooks/useAdminUsers";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";
import type { AdminUser } from "@/api/types";

type ModalState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; user: AdminUser }
  | { kind: "delete"; user: AdminUser }
  | { kind: "reset"; user: AdminUser }
  | { kind: "usage"; user: AdminUser };

export function UsersPanel() {
  const currentUserId = useAuthStore((s) => s.user?.id);

  const { data: users, isLoading, isError, error, refetch } = useAdminUsers();
  const { data: pool, isLoading: poolLoading } = useAdminModelPool();
  const createUser = useCreateAdminUser();
  const updateUser = useUpdateAdminUser();
  const deleteUser = useDeleteAdminUser();
  const unlockUser = useUnlockUser();
  const disableUser = useDisableUser();
  const enableUser = useEnableUser();
  const logoutEverywhere = useLogoutEverywhere();
  const resetPassword = useResetUserPassword();

  const [modal, setModal] = useState<ModalState>({ kind: "closed" });
  const close = () => setModal({ kind: "closed" });

  const handleCreate = async (values: UserFormValues) => {
    await createUser.mutateAsync({
      email: values.email,
      username: values.username,
      password: values.password,
      role: values.role,
      allowed_models: values.allowed_models,
      storage_cap_bytes: values.storage_cap_bytes,
      daily_token_budget: values.daily_token_budget,
      monthly_token_budget: values.monthly_token_budget,
    });
  };

  // Helper to only ship a quota field when it actually changed. Sending
  // `null` reverts a user to the org-wide default; omitting the key
  // leaves their override untouched. The form gives us the post-edit
  // value (number | null), so compare with `!=` to coerce numeric vs
  // string-numeric edge cases the same way the form does.
  const diffQuota = (next: number | null | undefined, prev: number | null) =>
    next === undefined ? undefined : next === prev ? undefined : next;

  const handleEdit = async (target: AdminUser, values: UserFormValues) => {
    await updateUser.mutateAsync({
      id: target.id,
      payload: {
        email: values.email !== target.email ? values.email : undefined,
        username:
          values.username !== target.username ? values.username : undefined,
        password: values.password ? values.password : undefined,
        role: values.role !== target.role ? values.role : undefined,
        allowed_models: values.allowed_models,
        storage_cap_bytes: diffQuota(
          values.storage_cap_bytes,
          target.storage_cap_bytes
        ),
        daily_token_budget: diffQuota(
          values.daily_token_budget,
          target.daily_token_budget
        ),
        monthly_token_budget: diffQuota(
          values.monthly_token_budget,
          target.monthly_token_budget
        ),
      },
    });
  };

  const handleDelete = async (target: AdminUser) => {
    await deleteUser.mutateAsync(target.id);
    close();
  };

  const handleResetPassword = async (target: AdminUser, password: string) => {
    await resetPassword.mutateAsync({
      id: target.id,
      payload: { password },
    });
  };

  const lockedCount = (users ?? []).filter((u) => u.locked_at !== null).length;
  const disabledCount = (users ?? []).filter((u) => u.disabled).length;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs">
          {lockedCount > 0 && (
            <Pill tone="danger" icon={<Lock className="h-3 w-3" />}>
              {lockedCount} locked
            </Pill>
          )}
          {disabledCount > 0 && (
            <Pill tone="warn" icon={<Ban className="h-3 w-3" />}>
              {disabledCount} disabled
            </Pill>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setModal({ kind: "create" })}
        >
          Create user
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading users…
        </div>
      )}

      {isError && (
        <div
          role="alert"
          className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
        >
          Failed to load users:{" "}
          {error instanceof Error ? error.message : "Unknown error"}
          <Button size="sm" variant="ghost" className="ml-3" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {users && users.length > 0 && (
        <div className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-black/[0.02] text-left text-[11px] uppercase tracking-wider text-[var(--text-muted)] dark:bg-white/[0.03]">
                <th className="px-4 py-2.5 font-semibold">User</th>
                <th className="px-4 py-2.5 font-semibold">Role</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold">Last seen</th>
                <th className="px-4 py-2.5 font-semibold">Model access</th>
                <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  isSelf={u.id === currentUserId}
                  poolSize={pool?.length ?? 0}
                  onEdit={() => setModal({ kind: "edit", user: u })}
                  onDelete={() => setModal({ kind: "delete", user: u })}
                  onResetPassword={() => setModal({ kind: "reset", user: u })}
                  onViewUsage={() => setModal({ kind: "usage", user: u })}
                  onUnlock={() => unlockUser.mutate(u.id)}
                  onDisable={() => disableUser.mutate(u.id)}
                  onEnable={() => enableUser.mutate(u.id)}
                  onLogoutEverywhere={() => logoutEverywhere.mutate(u.id)}
                  busy={
                    unlockUser.isPending ||
                    disableUser.isPending ||
                    enableUser.isPending ||
                    logoutEverywhere.isPending
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <UserFormModal
        open={modal.kind === "create"}
        mode="create"
        pool={pool ?? []}
        poolLoading={poolLoading}
        onClose={close}
        onSubmit={handleCreate}
      />
      <UserFormModal
        open={modal.kind === "edit"}
        mode="edit"
        user={modal.kind === "edit" ? modal.user : null}
        pool={pool ?? []}
        poolLoading={poolLoading}
        onClose={close}
        onSubmit={(values) =>
          modal.kind === "edit" ? handleEdit(modal.user, values) : Promise.resolve()
        }
      />
      <DeleteUserModal
        open={modal.kind === "delete"}
        username={modal.kind === "delete" ? modal.user.username : ""}
        onClose={close}
        onConfirm={() =>
          modal.kind === "delete" ? handleDelete(modal.user) : Promise.resolve()
        }
      />
      <ResetPasswordModal
        open={modal.kind === "reset"}
        username={modal.kind === "reset" ? modal.user.username : ""}
        onClose={close}
        onConfirm={(password) =>
          modal.kind === "reset"
            ? handleResetPassword(modal.user, password)
            : Promise.resolve()
        }
      />
      <UserUsageModal
        open={modal.kind === "usage"}
        user={modal.kind === "usage" ? modal.user : null}
        onClose={close}
      />
    </>
  );
}

// --------------------------------------------------------------------
// Row
// --------------------------------------------------------------------
interface UserRowProps {
  user: AdminUser;
  isSelf: boolean;
  poolSize: number;
  onEdit: () => void;
  onDelete: () => void;
  onResetPassword: () => void;
  onViewUsage: () => void;
  onUnlock: () => void;
  onDisable: () => void;
  onEnable: () => void;
  onLogoutEverywhere: () => void;
  busy: boolean;
}

function UserRow({
  user,
  isSelf,
  poolSize,
  onEdit,
  onDelete,
  onResetPassword,
  onViewUsage,
  onUnlock,
  onDisable,
  onEnable,
  onLogoutEverywhere,
  busy,
}: UserRowProps) {
  const isAdmin = user.role === "admin";
  const allowed = user.allowed_models;
  const accessLabel = isAdmin
    ? "Full (admin)"
    : allowed === null
      ? `Full (${poolSize})`
      : `${allowed.length} / ${poolSize}`;

  const initials = user.username.slice(0, 2).toUpperCase();
  const isLocked = user.locked_at !== null;

  return (
    <tr className="border-t border-[var(--border)] first:border-t-0 align-middle">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)]/20 text-xs font-semibold text-[var(--text)]">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{user.username}</span>
              {isSelf && (
                <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] ring-1 ring-[var(--border)]">
                  You
                </span>
              )}
            </div>
            <div className="truncate text-xs text-[var(--text-muted)]">
              {user.email}
            </div>
          </div>
        </div>
      </td>

      <td className="px-4 py-3">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            isAdmin
              ? "bg-[var(--accent)]/10 text-[var(--accent)]"
              : "bg-black/[0.04] text-[var(--text-muted)] dark:bg-white/[0.06]"
          )}
        >
          {isAdmin ? <ShieldCheck className="h-3 w-3" /> : <UserIcon className="h-3 w-3" />}
          {isAdmin ? "Admin" : "User"}
        </span>
      </td>

      <td className="px-4 py-3">
        <StatusBadges user={user} />
      </td>

      <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
        {user.last_login_at ? (
          <div title={`${user.last_login_at}${user.last_login_ip ? `\n${user.last_login_ip}` : ""}`}>
            {formatRelative(new Date(user.last_login_at))}
          </div>
        ) : (
          <span className="text-[var(--text-muted)]">Never</span>
        )}
      </td>

      <td className="px-4 py-3 text-xs text-[var(--text-muted)]">{accessLabel}</td>

      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <IconButton onClick={onEdit} title="Edit user" ariaLabel={`Edit ${user.username}`}>
            <Pencil className="h-3.5 w-3.5" />
          </IconButton>
          <ActionMenu
            user={user}
            isSelf={isSelf}
            isLocked={isLocked}
            busy={busy}
            onResetPassword={onResetPassword}
            onViewUsage={onViewUsage}
            onUnlock={onUnlock}
            onDisable={onDisable}
            onEnable={onEnable}
            onLogoutEverywhere={onLogoutEverywhere}
            onDelete={onDelete}
          />
        </div>
      </td>
    </tr>
  );
}

function StatusBadges({ user }: { user: AdminUser }) {
  const isLocked = user.locked_at !== null;
  if (user.disabled) {
    return (
      <Pill tone="danger" icon={<Ban className="h-3 w-3" />}>
        Disabled
      </Pill>
    );
  }
  if (isLocked) {
    return (
      <Pill tone="danger" icon={<Lock className="h-3 w-3" />}>
        Locked
      </Pill>
    );
  }
  if (user.failed_login_attempts > 0) {
    return (
      <Pill tone="warn" icon={<Lock className="h-3 w-3" />}>
        {user.failed_login_attempts} failed
      </Pill>
    );
  }
  if (user.must_change_password) {
    return (
      <Pill tone="warn" icon={<KeyRound className="h-3 w-3" />}>
        Must change password
      </Pill>
    );
  }
  return (
    <Pill tone="success" icon={<CheckCircle2 className="h-3 w-3" />}>
      Active
    </Pill>
  );
}

// --------------------------------------------------------------------
// Per-user action menu (portal-anchored to escape table overflow)
// --------------------------------------------------------------------
interface ActionMenuProps {
  user: AdminUser;
  isSelf: boolean;
  isLocked: boolean;
  busy: boolean;
  onResetPassword: () => void;
  onViewUsage: () => void;
  onUnlock: () => void;
  onDisable: () => void;
  onEnable: () => void;
  onLogoutEverywhere: () => void;
  onDelete: () => void;
}

function ActionMenu({
  user,
  isSelf,
  isLocked,
  busy,
  onResetPassword,
  onViewUsage,
  onUnlock,
  onDisable,
  onEnable,
  onLogoutEverywhere,
  onDelete,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const close = () => setOpen(false);
  const wrap = (fn: () => void) => () => {
    close();
    fn();
  };

  return (
    <>
      <IconButton
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        title="More actions"
        ariaLabel={`More actions for ${user.username}`}
        active={open}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </IconButton>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className={cn(
              "fixed z-50 min-w-[14rem] overflow-hidden rounded-card border shadow-lg",
              "border-[var(--border)] bg-[var(--surface)]"
            )}
            style={{ top: pos.top, right: pos.right }}
          >
            <MenuItem
              icon={<KeyRound className="h-3.5 w-3.5" />}
              label="Reset password…"
              onClick={wrap(onResetPassword)}
            />
            <MenuItem
              icon={<BarChart3 className="h-3.5 w-3.5" />}
              label="View usage…"
              onClick={wrap(onViewUsage)}
            />
            {isLocked ? (
              <MenuItem
                icon={<Unlock className="h-3.5 w-3.5" />}
                label="Unlock account"
                onClick={wrap(onUnlock)}
                disabled={busy}
              />
            ) : null}
            <MenuItem
              icon={<LogOut className="h-3.5 w-3.5" />}
              label="Log out everywhere"
              onClick={wrap(onLogoutEverywhere)}
              disabled={busy}
            />
            {user.disabled ? (
              <MenuItem
                icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                label="Enable account"
                onClick={wrap(onEnable)}
                disabled={busy}
              />
            ) : (
              <MenuItem
                icon={<Ban className="h-3.5 w-3.5" />}
                label="Disable account"
                onClick={wrap(onDisable)}
                disabled={busy || isSelf}
                title={isSelf ? "You can't disable yourself" : undefined}
              />
            )}
            <div className="border-t border-[var(--border)]" />
            <MenuItem
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label="Delete user…"
              onClick={wrap(onDelete)}
              disabled={isSelf}
              title={isSelf ? "You can't delete yourself" : undefined}
              tone="danger"
            />
          </div>,
          document.body
        )}
    </>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  title,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition",
        "disabled:cursor-not-allowed disabled:opacity-50",
        tone === "danger"
          ? "text-red-600 hover:bg-red-500/10 dark:text-red-400"
          : "text-[var(--text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// --------------------------------------------------------------------
// Tiny presentational helpers
// --------------------------------------------------------------------
type PillTone = "success" | "warn" | "danger" | "info";

function Pill({
  tone,
  icon,
  children,
}: {
  tone: PillTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const styles: Record<PillTone, string> = {
    success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    info: "bg-[var(--accent)]/10 text-[var(--accent)]",
    warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        styles[tone]
      )}
    >
      {icon}
      {children}
    </span>
  );
}

// `forwardRef` is load-bearing here. React 18 silently drops a ``ref``
// prop unless the recipient component is wrapped in ``forwardRef``,
// which meant the ActionMenu trigger above used to end up with a dead
// ``triggerRef`` whose ``.current`` was always null. That in turn left
// ``pos`` null, so the portal menu never rendered — the 3-dots button
// appeared inert. Do not "simplify" this back to a plain function
// component that accepts ``ref`` in its props.
interface IconButtonProps {
  onClick: () => void;
  title: string;
  ariaLabel: string;
  children: React.ReactNode;
  active?: boolean;
}

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ onClick, title, ariaLabel, children, active }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        title={title}
        aria-label={ariaLabel}
        className={cn(
          "rounded-md p-1.5 transition",
          active
            ? "bg-black/[0.06] text-[var(--text)] dark:bg-white/[0.08]"
            : "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
        )}
      >
        {children}
      </button>
    );
  }
);

function formatRelative(when: Date): string {
  const diffSec = Math.round((Date.now() - when.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 7 * 86_400) return `${Math.floor(diffSec / 86_400)}d ago`;
  return when.toLocaleDateString();
}
