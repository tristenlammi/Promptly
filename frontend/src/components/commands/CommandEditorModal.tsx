import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";

import {
  isSideEffecting,
  type Command,
  type CommandActionType,
  type CommandInput,
} from "@/api/commands";
import { Modal } from "@/components/shared/Modal";
import { Button } from "@/components/shared/Button";
import {
  useCommandTools,
  useCreateCommand,
  useUpdateCommand,
} from "@/hooks/useCommands";
import { useTasks } from "@/hooks/useTasks";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Create or edit one command.
 *
 * The form is shaped by what the matcher will actually do with it. It
 * matches exactly after normalisation — no fuzzy matching — so the
 * phrase list is the whole contract, and the editor's job is to make
 * that obvious rather than let someone write one phrase and wonder why
 * their other wording does nothing.
 */
export function CommandEditorModal({
  open,
  onClose,
  command,
  defaultActionType = "prompt",
}: {
  open: boolean;
  onClose: () => void;
  /** Null creates a new one. */
  command: Command | null;
  defaultActionType?: CommandActionType;
}) {
  const create = useCreateCommand();
  const update = useUpdateCommand();
  const { data: tasks } = useTasks();

  const [form, setForm] = useState<CommandInput>({ name: "" });
  const [phraseDraft, setPhraseDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPhraseDraft("");
    setForm(
      command
        ? {
            name: command.name,
            phrases: [...(command.phrases ?? [])],
            action_type: command.action_type,
            action_ref: command.action_ref,
            body: command.body,
            response_template: command.response_template,
            enabled: command.enabled,
            confirm_before_run: command.confirm_before_run,
          }
        : {
            name: "",
            phrases: [],
            action_type: defaultActionType,
            body: defaultActionType === "prompt" ? "" : null,
            enabled: true,
          }
    );
  }, [open, command, defaultActionType]);

  const actionType = (form.action_type ?? "prompt") as CommandActionType;
  const phrases = form.phrases ?? [];

  // Slots declared in the phrases, so the body can reference them and
  // the user can see what will be captured.
  const slots = useMemo(() => {
    const found = new Set<string>();
    for (const p of phrases) {
      for (const m of p.matchAll(/\{([a-zA-Z0-9_]{1,32})\}/g)) {
        found.add(m[1].toLowerCase());
      }
    }
    return [...found];
  }, [phrases]);

  const addPhrase = () => {
    const next = phraseDraft.trim();
    if (!next) return;
    if (phrases.some((p) => p.toLowerCase() === next.toLowerCase())) {
      setPhraseDraft("");
      return;
    }
    setForm({ ...form, phrases: [...phrases, next] });
    setPhraseDraft("");
  };

  const save = async () => {
    setError(null);
    if (!form.name?.trim()) {
      setError("Give it a name.");
      return;
    }
    if (actionType === "prompt" && !form.body?.trim()) {
      setError("A prompt needs some text to insert.");
      return;
    }
    if (actionType !== "prompt" && !form.action_ref) {
      setError(
        actionType === "automation"
          ? "Pick the automation this runs."
          : "Set the tool this calls."
      );
      return;
    }
    try {
      const payload: CommandInput = {
        ...form,
        // Keep the shape honest per type so a command that switched
        // type doesn't carry a stale target or an orphan body.
        body: actionType === "prompt" ? (form.body ?? "") : null,
        action_ref: actionType === "prompt" ? null : (form.action_ref ?? null),
      };
      if (command) {
        await update.mutateAsync({ id: command.id, input: payload });
      } else {
        await create.mutateAsync(payload);
      }
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, "Couldn't save that."));
    }
  };

  const busy = create.isPending || update.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={command ? "Edit" : actionType === "prompt" ? "New prompt" : "New command"}
      widthClass="max-w-lg"
      dismissible={!busy}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" hint="What it's called in the menu">
          <input
            value={form.name ?? ""}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Garage lights off"
            className={inputClass}
          />
        </Field>

        {!command && (
          <Field label="What it does">
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["prompt", "Insert text"],
                  ["automation", "Run an automation"],
                  ["mcp_tool", "Call a tool"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      action_type: value,
                      body: value === "prompt" ? (form.body ?? "") : null,
                      action_ref: value === "prompt" ? null : form.action_ref,
                    })
                  }
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition",
                    actionType === value
                      ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
        )}

        {actionType === "prompt" && (
          <Field
            label="Text"
            hint={
              slots.length
                ? `Use ${slots.map((s) => `{${s}}`).join(", ")} to drop in what was captured`
                : "Inserted into the composer for you to edit"
            }
          >
            <textarea
              value={form.body ?? ""}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              rows={5}
              placeholder="Write my standup for today…"
              className={cn(inputClass, "resize-y font-mono text-xs")}
            />
          </Field>
        )}

        {actionType === "automation" && (
          <Field label="Automation" hint="Only ones you own are listed">
            <select
              value={form.action_ref ?? ""}
              onChange={(e) => setForm({ ...form, action_ref: e.target.value })}
              className={inputClass}
            >
              <option value="">Choose an automation…</option>
              {(tasks ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title || "Untitled automation"}
                </option>
              ))}
            </select>
          </Field>
        )}

        {actionType === "mcp_tool" && (
          <ToolPicker
            value={form.action_ref ?? ""}
            onChange={(ref) => setForm({ ...form, action_ref: ref })}
            onPickDestructive={(destructive) => {
              // Only ever switches confirmation ON. Picking a harmless
              // tool afterwards shouldn't quietly undo a deliberate
              // decision to guard this command.
              if (destructive) {
                setForm((f) => ({ ...f, confirm_before_run: true }));
              }
            }}
          />
        )}

        <Field
          label="Phrases"
          hint={
            actionType === "prompt"
              ? "Optional. Leave empty and it's menu-only — never triggered by speech."
              : "How you'd say it. Wrap a variable part in braces: turn off the {room} lights"
          }
        >
          <div className="flex flex-wrap gap-1.5">
            {phrases.map((p) => (
              <span
                key={p}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text)]"
              >
                {p}
                <button
                  type="button"
                  aria-label={`Remove "${p}"`}
                  onClick={() =>
                    setForm({
                      ...form,
                      phrases: phrases.filter((x) => x !== p),
                    })
                  }
                  className="text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={phraseDraft}
              onChange={(e) => setPhraseDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPhrase();
                }
              }}
              placeholder="turn off the garage lights"
              className={inputClass}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={addPhrase}
              leftIcon={<Plus className="h-3.5 w-3.5" />}
            >
              Add
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
            Matching is exact once wording like &ldquo;Promptly&rdquo;,
            &ldquo;please&rdquo; and punctuation are ignored — so add every
            way you'd actually say it. Nothing is guessed.
          </p>
        </Field>

        {isSideEffecting(actionType) && (
          <label className="flex items-start gap-2.5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5">
            <input
              type="checkbox"
              checked={!!form.confirm_before_run}
              onChange={(e) =>
                setForm({ ...form, confirm_before_run: e.target.checked })
              }
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-sm text-[var(--text)]">
                Ask before running this one
              </span>
              <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                Off by default — a command you picked from a menu or said
                out loud is already deliberate. Turn it on for anything
                you'd hate to trigger by accident, like a garage door.
              </span>
            </span>
          </label>
        )}

        {isSideEffecting(actionType) && (
          <Field label="Spoken reply" hint="Optional — keeps it model-free and instant">
            <input
              value={form.response_template ?? ""}
              onChange={(e) =>
                setForm({ ...form, response_template: e.target.value })
              }
              placeholder="Garage lights off."
              className={inputClass}
            />
          </Field>
        )}

        {error && (
          <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Pick a connector, then a tool from its catalog.
 *
 * This replaced a free-text field that expected
 * ``<connector-uuid>:<tool-name>`` typed by hand — which meant digging a
 * UUID out of an admin API before you could make a command. The catalog
 * is already cached per connector, so the only real question was whose
 * job it is to know the id, and it shouldn't be the user's.
 *
 * Refresh is manual, like the model picker: catalogs change when an
 * admin adds a connector, not while you're filling in a form.
 */
function ToolPicker({
  value,
  onChange,
  onPickDestructive,
}: {
  value: string;
  onChange: (ref: string) => void;
  /** Fired when the chosen tool is one the connector flags as changing
   *  something, so the editor can switch confirmation on for it. */
  onPickDestructive: (destructive: boolean) => void;
}) {
  const { data: sources, isLoading, isFetching, refetch } = useCommandTools();
  const [connectorId, toolName] = useMemo(() => {
    const at = value.indexOf(":");
    return at === -1 ? ["", ""] : [value.slice(0, at), value.slice(at + 1)];
  }, [value]);

  const active = (sources ?? []).find((s) => s.connector_id === connectorId);
  const withTools = (sources ?? []).filter((s) => s.tools.length > 0);

  return (
    <Field
      label="Tool"
      hint="From your connected services — Home Assistant, UniFi, anything else an admin has added."
    >
      {isLoading ? (
        <p className="text-xs text-[var(--text-muted)]">Loading tools…</p>
      ) : withTools.length === 0 ? (
        // Says which of the two reasons it's empty, because "no tools"
        // and "a connector with nothing exposed" need different fixes.
        <p className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)]">
          No tools available.{" "}
          {(sources?.length ?? 0) > 0
            ? "Your connectors haven't reported any tools yet — an admin can refresh their catalogs in Settings → Connectors."
            : "An admin needs to add a connector first (Settings → Connectors)."}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <select
            value={connectorId}
            onChange={(e) => onChange(e.target.value ? `${e.target.value}:` : "")}
            className={inputClass}
          >
            <option value="">Choose a connector…</option>
            {withTools.map((s) => (
              <option key={s.connector_id} value={s.connector_id}>
                {s.connector_name} ({s.tools.length})
              </option>
            ))}
          </select>

          {active && (
            <select
              value={toolName}
              onChange={(e) => {
                const picked = e.target.value;
                onChange(`${connectorId}:${picked}`);
                onPickDestructive(
                  !!active.tools.find((t) => t.name === picked)?.destructive
                );
              }}
              className={inputClass}
            >
              <option value="">Choose a tool…</option>
              {active.tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                  {t.destructive ? " — changes something" : ""}
                </option>
              ))}
            </select>
          )}

          {active && toolName && (
            <p className="text-[11px] text-[var(--text-muted)]">
              {active.tools.find((t) => t.name === toolName)?.description ||
                "No description provided by the connector."}
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => void refetch()}
        disabled={isFetching}
        className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] transition hover:text-[var(--text)] disabled:opacity-50"
      >
        <RefreshCw
          className={cn("h-3 w-3", isFetching && "animate-spin")}
        />
        {isFetching ? "Refreshing…" : "Refresh list"}
      </button>
    </Field>
  );
}

const inputClass =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-[var(--text)]">
        {label}
      </span>
      {hint && (
        <span className="mb-1.5 block text-xs text-[var(--text-muted)]">
          {hint}
        </span>
      )}
      {children}
    </label>
  );
}
