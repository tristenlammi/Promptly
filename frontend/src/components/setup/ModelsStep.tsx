import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import { adminApi, type AppSettingsPatch } from "@/api/admin";
import { modelsApi } from "@/api/models";
import { setupApi, type ModelRole, type ModelSuggestions } from "@/api/setup";
import type { AvailableModel } from "@/api/types";
import { Button } from "@/components/shared/Button";
import { AVAILABLE_MODELS_KEY } from "@/hooks/useProviders";
import { useModelStore } from "@/store/modelStore";
import { apiErrorMessage } from "@/utils/apiError";

const key = (providerId: string, modelId: string) => `${providerId}::${modelId}`;

function split(value: string): [string, string] | null {
  const [providerId, ...rest] = value.split("::");
  const modelId = rest.join("::");
  return providerId && modelId ? [providerId, modelId] : null;
}

/** What a job may be given: any chat model, only ones that can see
 *  pictures, or only ones that can make them. */
function fits(m: AvailableModel, only: ModelRole["only"]): boolean {
  if (m.is_custom) return false;
  if (only === "image") return m.supports_image_output === true;
  if (m.supports_image_output) return false;
  if (/embed/i.test(m.model_id)) return false;
  return only === "vision" ? m.supports_vision === true : true;
}

/**
 * Which model does each job. The server suggests one per job from what the
 * connected AI service offers; "Use these" saves them all at once, through
 * the same settings Admin → Models → Defaults edits.
 */
export function ModelsStep({
  onDone,
  onConnect,
  doneLabel = "Use these",
}: {
  onDone: () => void;
  /** Go (back) to connecting an AI service. */
  onConnect: () => void;
  doneLabel?: string;
}) {
  const [info, setInfo] = useState<ModelSuggestions | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    let alive = true;
    Promise.all([setupApi.modelSuggestions(), modelsApi.available()])
      .then(([s, all]) => {
        if (!alive) return;
        setInfo(s);
        setModels(all);
        const start: Record<string, string> = {};
        for (const r of s.roles) {
          // What's already saved wins; else the suggestion.
          const pick = r.current ?? r.suggestion;
          start[r.role] = pick ? key(pick.provider_id, pick.model_id) : "";
        }
        setPicked(start);
      })
      .catch((err) => alive && setLoadError(apiErrorMessage(err, "Couldn't load the models.")));
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    if (!info) return;
    setError(null);
    setSaving(true);
    try {
      const patch: Record<string, string | null> = {};
      const chat = split(picked.chat ?? "");
      // With the built-in Promptly model, the chat pick is the model
      // behind it, and Promptly becomes what new chats start on.
      const viaPromptly = !!info.promptly && !!chat;
      for (const r of info.roles) {
        if (r.role === "chat" && (viaPromptly || info.promptly)) continue;
        const pair = split(picked[r.role] ?? "");
        patch[`${r.field}_provider_id`] = pair ? pair[0] : null;
        patch[`${r.field}_model_id`] = pair ? pair[1] : null;
      }
      if (Object.keys(patch).length) await adminApi.updateAppSettings(patch as AppSettingsPatch);
      // The admin's own chat picker follows straight away.
      if (viaPromptly && chat) {
        const saved = await setupApi.setPromptlyModel(chat[0], chat[1], true);
        useModelStore.getState().setAdminDefault(saved.default_chat_provider_id, saved.default_chat_model_id);
        // The admin who just chose it chats on it too.
        useModelStore.getState().setSelection(saved.provider_id, saved.model_id);
        await qc.invalidateQueries({ queryKey: AVAILABLE_MODELS_KEY });
      } else if (!info.promptly) {
        useModelStore.getState().setAdminDefault(chat ? chat[0] : null, chat ? chat[1] : null);
      }
      const see = split(picked.see ?? "");
      useModelStore.getState().setVisionRelay(see ? see[0] : null, see ? see[1] : null);
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't save the models."));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="space-y-3">
        <div role="alert" className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {loadError}
        </div>
        <Button variant="secondary" className="w-full" onClick={onDone}>
          Skip for now
        </Button>
      </div>
    );
  }
  if (!info) {
    return <div className="py-6 text-center text-xs text-[var(--text-muted)]">Looking at the models you have…</div>;
  }

  if (!info.has_models) {
    return (
      <div className="space-y-3" data-testid="models-step-empty">
        <div className="rounded-card border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
          <p className="font-medium">No AI service is connected, so there are no models to choose yet.</p>
          <p className="mt-2">Until one is connected, these won't work:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>Chat, and asking questions about your files, mail and photos</li>
            <li>The assistant inside Notes, Docs, Sheets, Mail and the other apps</li>
            <li>Talking to Promptly</li>
            <li>Summaries, drafts and chat titles</li>
          </ul>
          <p className="mt-2">
            Everything else does: files, photos, notes, calendar, mail, messages, calls, maps and passwords.
          </p>
        </div>
        <Button variant="primary" className="w-full" onClick={onConnect}>
          Connect an AI service
        </Button>
        <button
          type="button"
          onClick={onDone}
          className="w-full text-center text-xs text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text)]"
        >
          Continue without one
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="models-step">
      <div className="flex items-start gap-2.5 rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-xs leading-relaxed text-[var(--text-muted)]">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden />
        <div>
          Promptly uses a model for each of these jobs. We've picked one for each from what you connected. Keep them
          or change any: you can always change them later in Admin → Models.
        </div>
      </div>

      {info.roles.map((r) => (
        <RolePicker
          key={r.role}
          role={r}
          models={models}
          value={picked[r.role] ?? ""}
          onChange={(v) => setPicked((p) => ({ ...p, [r.role]: v }))}
          disabled={saving}
        />
      ))}

      {error && (
        <div role="alert" className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <Button type="button" variant="primary" className="w-full" onClick={save} loading={saving}>
        {doneLabel}
      </Button>
      <button
        type="button"
        onClick={onDone}
        disabled={saving}
        className="w-full text-center text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        Skip for now
      </button>
    </div>
  );
}

function RolePicker({
  role,
  models,
  value,
  onChange,
  disabled,
}: {
  role: ModelRole;
  models: AvailableModel[];
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const options = useMemo(() => models.filter((m) => fits(m, role.only)), [models, role.only]);
  const groups = useMemo(() => {
    const by = new Map<string, AvailableModel[]>();
    for (const m of options) by.set(m.provider_name, [...(by.get(m.provider_name) ?? []), m]);
    return Array.from(by.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [options]);
  const suggested = role.suggestion ? key(role.suggestion.provider_id, role.suggestion.model_id) : null;
  const id = `setup-model-${role.role}`;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-[var(--text)]">
        {role.label}
      </label>
      <p className="mb-1.5 mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">{role.what}</p>
      {options.length === 0 ? (
        <p className="rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)]" data-testid={`${id}-none`}>
          {role.only === "image"
            ? "None of your models can make pictures, so this stays off for now."
            : "None of your models can see pictures, so this stays off for now."}
        </p>
      ) : (
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-60"
        >
          <option value="">{role.unset}</option>
          {groups.map(([provider, entries]) => (
            <optgroup key={provider} label={provider}>
              {entries.map((m) => {
                const k = key(m.provider_id, m.model_id);
                return (
                  <option key={k} value={k}>
                    {m.display_name || m.model_id}
                    {k === suggested ? " (suggested)" : ""}
                  </option>
                );
              })}
            </optgroup>
          ))}
        </select>
      )}
    </div>
  );
}
