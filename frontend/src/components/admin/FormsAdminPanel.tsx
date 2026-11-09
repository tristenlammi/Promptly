import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Flag, Paperclip } from "lucide-react";
import { useState } from "react";

import { formsAdminApi, type AdminFormRow, type AdminFormsOverview } from "@/api/formsAdmin";
import { formatRelativeTime } from "@/components/files/helpers";
import { Button } from "@/components/shared/Button";
import { EmptyState } from "@/components/shared/EmptyState";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { SettingsCard } from "./SettingsCard";

const KEY = ["admin", "forms"];

/**
 * Admin → Forms (Forms WP-F1.3): whether people without an account can
 * answer forms at all, how many link forms there are, the forms someone
 * reported with their reports, and closing one (its owner is told why);
 * and how much each form may take in files a day (WP-F1.6). Other forms'
 * titles and owners, and every form's answers, aren't shown here (admin
 * privacy, owner decision 2026-11-09).
 */
export function FormsAdminPanel() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: KEY, queryFn: () => formsAdminApi.overview() });
  const toggle = useMutation({
    mutationFn: (on: boolean) => formsAdminApi.setLinkAnswers(on),
    onSuccess: (d) => qc.setQueryData(KEY, d),
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  if (isLoading) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  if (error || !data) return <p className="text-sm text-[var(--danger)]">{apiErrorMessage(error, "Forms couldn't be loaded.")}</p>;

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard title="Answers from people without an account" icon={<ClipboardList className="h-4 w-4" />}>
        <label className="flex items-start gap-2 text-sm text-[var(--text)]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={data.link_answers}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
          <span>
            Let people answer forms with just the link
            <span className="block text-xs text-[var(--text-muted)]">
              Off: every “Anyone with the link” form says it doesn&apos;t exist, and nobody can switch a form to it.
              Forms for people on this server keep working. Spam limits are always on.
            </span>
          </span>
        </label>
      </SettingsCard>

      <SettingsCard title="Files sent with answers" icon={<Paperclip className="h-4 w-4" />}>
        <p className="text-xs text-[var(--text-muted)]">
          The most each form can take in files in 24 hours. Files count against the form owner&apos;s storage. People
          without an account can only send pictures and PDFs, and only to forms that allow it. This server doesn&apos;t
          scan files for viruses.
        </p>
        <div className="mt-3 flex flex-wrap gap-4">
          <CapField
            label="Forms for people on this server"
            value={data.upload_cap_mb}
            onSave={(mb) => formsAdminApi.setUploadCaps({ upload_cap_mb: mb }).then((d) => qc.setQueryData(KEY, d))}
          />
          <CapField
            label="Forms anyone with the link can answer"
            value={data.link_upload_cap_mb}
            onSave={(mb) => formsAdminApi.setUploadCaps({ link_upload_cap_mb: mb }).then((d) => qc.setQueryData(KEY, d))}
          />
        </div>
      </SettingsCard>

      <section aria-labelledby="admin-forms-h" className="flex flex-col gap-2">
        <h2 id="admin-forms-h" className="text-sm font-semibold text-[var(--text)]">
          Reported forms
        </h2>
        <p className="text-xs text-[var(--text-muted)]">
          {data.link_form_count === 0
            ? "No forms are open to anyone with the link right now."
            : data.link_form_count === 1
              ? "1 form can be answered by anyone with the link."
              : `${data.link_form_count} forms can be answered by anyone with the link.`}{" "}
          Only forms someone reported are listed. You can close one here; you can&apos;t read its answers.
        </p>
        {data.forms.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="h-5 w-5" />}
            title="No reports"
            description="Nobody has reported a form. If someone does, it shows here."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
            {data.forms.map((f) => (
              <FormRow key={f.form_id} row={f} onData={(d) => qc.setQueryData(KEY, d)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One allowance, in MB a day, saved when it's changed and left. */
function CapField({ label, value, onSave }: { label: string; value: number; onSave: (mb: number) => Promise<unknown> }) {
  const [text, setText] = useState(String(value));
  const [saving, setSaving] = useState(false);
  const id = `cap-${label.replace(/\W+/g, "-").toLowerCase()}`;
  const save = async () => {
    const mb = Math.round(Number(text));
    if (!Number.isFinite(mb) || mb < 1 || mb > 100000) {
      toast.error("Enter a number of MB from 1 to 100,000.");
      setText(String(value));
      return;
    }
    if (mb === value) return;
    setSaving(true);
    try {
      await onSave(mb);
      toast.success("Saved");
    } catch (e) {
      toast.error(apiErrorMessage(e));
      setText(String(value));
    } finally {
      setSaving(false);
    }
  };
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
      {label}
      <span className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={100000}
          className="h-9 w-28 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-sm text-[var(--text)]"
          value={text}
          disabled={saving}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <span className="text-sm text-[var(--text)]">MB a day</span>
      </span>
    </label>
  );
}

const STATE_WORDS: Record<AdminFormRow["state"], string> = { open: "Open", closed: "Closed", trashed: "In the trash" };

function FormRow({ row, onData }: { row: AdminFormRow; onData: (d: AdminFormsOverview) => void }) {
  const [showReports, setShowReports] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const reports = useQuery({
    queryKey: ["admin", "forms", row.form_id, "reports"],
    queryFn: () => formsAdminApi.reports(row.form_id),
    enabled: showReports,
  });
  const close = useMutation({
    mutationFn: () => formsAdminApi.close(row.form_id, reason.trim()),
    onSuccess: (d) => {
      onData(d);
      setClosing(false);
      setReason("");
      toast.success("Form closed. Its owner has been told why.");
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });
  return (
    <li className="flex flex-col gap-2 px-3 py-3" data-admin-form={row.form_id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--text)]">{row.title}</div>
          <div className="text-xs text-[var(--text-muted)]">
            {row.owner ?? "Deleted account"} · {row.answers === 1 ? "1 answer" : `${row.answers} answers`}
            {row.created_at ? ` · made ${formatRelativeTime(row.created_at)}` : ""}
            {row.audience === "server" ? " · people on this server" : ""}
          </div>
        </div>
        <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)]">{STATE_WORDS[row.state]}</span>
        {row.reports > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full bg-[var(--warning-bg)] px-2 py-0.5 text-xs font-medium text-[var(--warning)]"
            aria-expanded={showReports}
            onClick={() => setShowReports((v) => !v)}
          >
            <Flag className="h-3 w-3" aria-hidden="true" />
            {row.reports === 1 ? "1 report" : `${row.reports} reports`}
          </button>
        )}
        {row.state === "open" && !closing && (
          <Button size="sm" variant="secondary" onClick={() => setClosing(true)}>
            Close
          </Button>
        )}
      </div>
      {showReports && (
        <ul aria-label={`Reports on ${row.title}`} className="flex flex-col gap-1.5 rounded-md bg-[var(--bg)] p-2 text-sm">
          {reports.isLoading && <li className="text-[var(--text-muted)]">Loading…</li>}
          {reports.data?.map((r) => (
            <li key={r.id} className="flex flex-col">
              {/* A stranger's words: plain text only. */}
              <span className="whitespace-pre-wrap break-words text-[var(--text)]">{r.reason || "(no reason given)"}</span>
              <span className="text-xs text-[var(--text-muted)]">{r.created_at ? formatRelativeTime(r.created_at) : ""}</span>
            </li>
          ))}
        </ul>
      )}
      {closing && (
        <div className="flex flex-col gap-2 rounded-md bg-[var(--bg)] p-2">
          <label htmlFor={`close-${row.form_id}`} className="text-sm text-[var(--text)]">
            Why are you closing it? Its owner sees this.
          </label>
          <input
            id={`close-${row.form_id}`}
            className="h-9 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]"
            maxLength={500}
            placeholder="For example: it asks people for their bank details"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setClosing(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" disabled={!reason.trim()} loading={close.isPending} onClick={() => close.mutate()}>
              Close the form
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
