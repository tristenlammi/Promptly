import { Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Field, ItemButton, ProgressBar, Select, Sheet, TextArea, TextInput, Toggle, uid } from "@/items/ui";
import type { ItemHandle } from "@/items/useItem";

import { approxBytes, normTag } from "./lib";
import { MAX_BYTES, type JournalData, type Settings, type Template } from "./types";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text)]">{title}</p>
        {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function SettingsSheet({ open, onClose, item, ask }: { open: boolean; onClose: () => void; item: ItemHandle<JournalData>; ask: (p: string) => void }) {
  const data = item.data;
  const s = data.settings;
  const ro = !item.canEdit;
  const [editing, setEditing] = useState<Template | null>(null);
  const [newPrompt, setNewPrompt] = useState("");
  const set = (p: Partial<Settings>) => item.update((d) => Object.assign(d.settings, p));
  const addPrompt = () => {
    const text = newPrompt.trim();
    if (!text) return;
    item.update((d) => {
      if (!d.settings.custom_prompts.includes(text) && d.settings.custom_prompts.length < 200) d.settings.custom_prompts.push(text);
    });
    setNewPrompt("");
  };
  const bytes = open ? approxBytes(data) : 0;
  const used = bytes / MAX_BYTES;

  return (
    <>
      <Sheet open={open && !editing} onClose={onClose} title="Journal settings" size="lg">
        <div className="flex flex-col gap-6 pb-2">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Reminders</h3>
            <div className="divide-y divide-[var(--border)]">
              <Row title="Daily reminder" hint="Skipped on days you've already written">
                <Toggle label="Daily reminder" checked={s.daily_reminder} onChange={(v) => !ro && set({ daily_reminder: v })} />
              </Row>
              {s.daily_reminder && (
                <Row title="Remind me at">
                  <TextInput type="time" className="w-32" value={s.reminder_time} disabled={ro} onChange={(e) => e.target.value && set({ reminder_time: e.target.value.slice(0, 5) })} />
                </Row>
              )}
              <Row title="Weekly reflection" hint="A nudge to look back on your week">
                <Toggle label="Weekly reflection reminder" checked={s.weekly_reminder} onChange={(v) => !ro && set({ weekly_reminder: v })} />
              </Row>
              {s.weekly_reminder && (
                <Row title="On">
                  <div className="flex gap-2">
                    <Select className="w-36" value={s.weekly_day} disabled={ro} onChange={(e) => set({ weekly_day: Number(e.target.value) })} aria-label="Reflection day">
                      {DAYS.map((d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ))}
                    </Select>
                    <TextInput type="time" className="w-28" value={s.weekly_time} disabled={ro} onChange={(e) => e.target.value && set({ weekly_time: e.target.value.slice(0, 5) })} aria-label="Reflection time" />
                  </div>
                </Row>
              )}
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Writing</h3>
            <div className="divide-y divide-[var(--border)]">
              <Row title="Prompt of the day">
                <Toggle label="Prompt of the day" checked={s.show_prompt} onChange={(v) => !ro && set({ show_prompt: v })} />
              </Row>
              <Row title="New entries start from">
                <Select className="w-48" value={s.default_template_id ?? ""} disabled={ro} onChange={(e) => set({ default_template_id: e.target.value || null })} aria-label="Default template">
                  <option value="">A blank page</option>
                  {data.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Row>
              <Row title="Weeks start on">
                <Select className="w-36" value={s.week_starts_on} disabled={ro} onChange={(e) => set({ week_starts_on: Number(e.target.value) as 0 | 1 })} aria-label="Week starts on">
                  <option value={1}>Monday</option>
                  <option value={0}>Sunday</option>
                </Select>
              </Row>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Privacy</h3>
            <div className="divide-y divide-[var(--border)]">
              <Row
                title="Let other chats see short excerpts"
                hint="Off: other chats, search and Drive AI see only an outline — dates, titles, moods and tags. On: also a short line from each recent entry."
              >
                <Toggle label="Let other chats see short excerpts" checked={s.share_excerpts} onChange={(v) => !ro && set({ share_excerpts: v })} />
              </Row>
              <Row title="Hide previews in lists" hint="Show titles only — for when someone can see your screen">
                <Toggle label="Hide previews in lists" checked={s.hide_previews} onChange={(v) => !ro && set({ hide_previews: v })} />
              </Row>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
              This journal's own assistant reads your entries to help, and sends them to the AI model your server uses — a cloud provider, if that's
              how it's set up. Your server's admins can technically read stored data. There's no end-to-end encryption or app lock yet.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Templates</h3>
              {!ro && (
                <ItemButton
                  size="sm"
                  icon={<Plus className="h-3.5 w-3.5" />}
                  onClick={() =>
                    setEditing({ id: "", name: "", description: "", body: "", prompts: [], gratitude_slots: 0, target_words: null, default_tags: [], builtin: false, hidden: false })
                  }
                >
                  New
                </ItemButton>
              )}
            </div>
            <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              {data.templates.map((t) => (
                <div key={t.id} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-sm font-medium ${t.hidden ? "text-[var(--text-muted)] line-through" : "text-[var(--text)]"}`}>{t.name}</p>
                    <p className="truncate text-xs text-[var(--text-muted)]">{t.builtin ? "Built in" : "Yours"}{t.description ? ` · ${t.description}` : ""}</p>
                  </div>
                  {!ro && (
                    <>
                      <button
                        type="button"
                        aria-label={t.hidden ? `Show ${t.name}` : `Hide ${t.name}`}
                        title={t.hidden ? "Show" : "Hide"}
                        onClick={() => {
                          const hidden = !t.hidden; // decided from what's on screen
                          item.update((d) => {
                            const x = d.templates.find((y) => y.id === t.id);
                            if (x) x.hidden = hidden;
                          });
                        }}
                        className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]"
                      >
                        {t.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                      <button type="button" aria-label={`Edit ${t.name}`} title="Edit" onClick={() => setEditing(t)} className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]">
                        <Pencil className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Your prompts</h3>
            <p className="text-xs text-[var(--text-muted)]">Added to the prompt of the day rotation.</p>
            {s.custom_prompts.map((p, i) => (
              <div key={i} className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5">
                <p className="min-w-0 flex-1 text-sm text-[var(--text)]">{p}</p>
                {!ro && (
                  <button
                    type="button"
                    aria-label="Remove prompt"
                    onClick={() =>
                      item.update((d) => {
                        // By text, not position: the list may have changed by replay time.
                        const at = d.settings.custom_prompts.indexOf(p);
                        if (at >= 0) d.settings.custom_prompts.splice(at, 1);
                      })
                    }
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
            {!ro && (
              <div className="flex gap-2">
                <TextInput
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value.slice(0, 300))}
                  placeholder="What am I avoiding, and why?"
                  aria-label="New prompt"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newPrompt.trim()) addPrompt();
                  }}
                />
                <ItemButton
                  disabled={!newPrompt.trim()}
                  onClick={addPrompt}
                >
                  Add
                </ItemButton>
              </div>
            )}
            <ItemButton variant="ghost" size="sm" className="self-start" onClick={() => { onClose(); ask("Suggest five journaling prompts for me, based on what I've been writing about lately, and add the ones I like."); }}>
              Ask the assistant for prompts
            </ItemButton>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Space</h3>
            <ProgressBar value={used} />
            <p className="text-xs text-[var(--text-muted)]">
              {data.entries.length.toLocaleString()} entries · {(bytes / 1024 / 1024).toFixed(1)} MB of {MAX_BYTES / 1024 / 1024} MB
              {used > 0.75
                ? " — this journal is filling up. Use “Archive older data” at the top of the journal to move older entries into an archive file (templates and settings come along)."
                : " — room for years of writing. When it fills up, older entries can be archived to a separate file."}
            </p>
          </section>
        </div>
      </Sheet>
      {editing && <TemplateEditor tpl={editing} item={item} onClose={() => setEditing(null)} />}
    </>
  );
}

function TemplateEditor({ tpl, item, onClose }: { tpl: Template; item: ItemHandle<JournalData>; onClose: () => void }) {
  const [t, setT] = useState<Template>(tpl);
  const isNew = !tpl.id;
  const save = () => {
    const clean: Template = {
      ...t,
      name: t.name.trim().slice(0, 80),
      target_words: t.target_words && t.target_words >= 10 ? Math.min(5000, t.target_words) : null,
      prompts: t.prompts.map((p) => p.trim()).filter(Boolean).slice(0, 20),
      default_tags: [...new Set(t.default_tags.map(normTag).filter(Boolean))].slice(0, 10),
    };
    if (isNew) {
      const id = uid("t"); // outside the mutator: a replay makes the same template
      item.update((d) => {
        if (!d.templates.some((x) => x.id === id)) d.templates.push({ ...clean, id });
      });
    } else {
      // Only the fields changed in this sheet.
      const keys = (Object.keys(clean) as (keyof Template)[]).filter((k) => JSON.stringify(clean[k]) !== JSON.stringify(tpl[k]));
      if (keys.length)
        item.update((d) => {
          const x = d.templates.find((y) => y.id === tpl.id);
          if (x) for (const k of keys) (x as unknown as Record<string, unknown>)[k] = clean[k];
        });
    }
    onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={isNew ? "New template" : `Edit “${tpl.name}”`}
      size="lg"
      footer={
        <>
          {!isNew && !tpl.builtin && (
            <ItemButton
              variant="ghost"
              className="text-[var(--danger)]"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => {
                item.update((d) => {
                  d.templates = d.templates.filter((x) => x.id !== tpl.id);
                  if (d.settings.default_template_id === tpl.id) d.settings.default_template_id = null;
                });
                onClose();
              }}
            >
              Delete
            </ItemButton>
          )}
          <ItemButton variant="primary" block disabled={!t.name.trim()} onClick={save}>
            Save template
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <Field label="Name">
          <TextInput value={t.name} maxLength={80} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="Sunday planning" />
        </Field>
        <Field label="Short description">
          <TextInput value={t.description} maxLength={300} onChange={(e) => setT({ ...t, description: e.target.value })} />
        </Field>
        <Field label="Starts with (Markdown)" hint="Headings make good sections: ## Wins">
          <TextArea rows={7} value={t.body} maxLength={5000} onChange={(e) => setT({ ...t, body: e.target.value })} className="font-mono text-sm" />
        </Field>
        <Field label="Prompts" hint="One per line — shown while writing">
          <TextArea rows={3} value={t.prompts.join("\n")} onChange={(e) => setT({ ...t, prompts: e.target.value.split("\n").slice(0, 20) })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Gratitude lines">
            <Select value={t.gratitude_slots} onChange={(e) => setT({ ...t, gratitude_slots: Number(e.target.value) })}>
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "None" : n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Word goal">
            <TextInput
              inputMode="numeric"
              value={t.target_words ?? ""}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setT({ ...t, target_words: Number.isFinite(n) ? Math.min(5000, n) : null });
              }}
              placeholder="e.g. 750"
            />
          </Field>
        </div>
        <Field label="Tags added" hint="Separate with spaces">
          <TextInput value={t.default_tags.join(" ")} onChange={(e) => setT({ ...t, default_tags: e.target.value.split(/[\s,]+/) })} placeholder="planning sunday" />
        </Field>
      </div>
    </Sheet>
  );
}
