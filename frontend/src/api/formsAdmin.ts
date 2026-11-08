import { apiClient } from "./client";

/**
 * Admin → Forms (``/api/admin/forms``, Forms WP-F1.3): the server-wide
 * switch for answers from people without an account, the forms anyone with
 * the link can answer (with reports), and closing one. Admins can't read
 * answers here.
 */

export interface AdminFormRow {
  form_id: string;
  title: string;
  owner: string | null;
  audience: "server" | "link";
  answers: number;
  created_at: string | null;
  state: "open" | "closed" | "trashed";
  reports: number;
  last_report_at: string | null;
}

export interface AdminFormsOverview {
  link_answers: boolean;
  forms: AdminFormRow[];
}

export interface FormReportRow {
  id: string;
  reason: string;
  created_at: string | null;
}

export const formsAdminApi = {
  async overview(): Promise<AdminFormsOverview> {
    const { data } = await apiClient.get<AdminFormsOverview>("/admin/forms");
    return data;
  },
  async setLinkAnswers(on: boolean): Promise<AdminFormsOverview> {
    const { data } = await apiClient.patch<AdminFormsOverview>("/admin/forms/settings", { link_answers: on });
    return data;
  },
  async reports(formId: string): Promise<FormReportRow[]> {
    const { data } = await apiClient.get<{ reports: FormReportRow[] }>(`/admin/forms/${formId}/reports`);
    return data.reports;
  },
  async close(formId: string, reason: string): Promise<AdminFormsOverview> {
    const { data } = await apiClient.post<AdminFormsOverview>(`/admin/forms/${formId}/close`, { reason });
    return data;
  },
};
