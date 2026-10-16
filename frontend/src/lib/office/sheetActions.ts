/**
 * Spreadsheets in, as a Files action (WP-4.4, Part C §3.7).
 *
 * "Open in Promptly Sheets" makes a new, editable sheet next to an uploaded
 * .xlsx / .xlsm / .ods / .csv, linked by ``source_file_id``; the original is
 * never changed. The server converts it (formatting, merges, column widths,
 * formulas) and says what didn't come across, which the sheet's page shows
 * once.
 */
import type { FileItem } from "@/api/files";
import { officeApi } from "@/api/office";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { rememberImportNotes } from "./importNotes";

export const SPREADSHEET_ACCEPT = ".xlsx,.xlsm,.ods,.csv,.tsv";

export function isSpreadsheetFile(file: Pick<FileItem, "filename" | "source_kind">): boolean {
  return !file.source_kind && /\.(xlsx|xlsm|ods|csv|tsv)$/i.test(file.filename);
}

/** Convert ``file`` into a new Promptly sheet and open it. Returns the new
 *  sheet, or null when it failed (a toast has said why). */
export async function openSpreadsheetAsSheet(
  file: Pick<FileItem, "id" | "filename">,
  navigate: (to: string) => void
): Promise<FileItem | null> {
  const working = toast.info(`Converting “${file.filename}”…`, { duration: 0 });
  try {
    const { file: created, path, notes } = await officeApi.openAsSheet(file.id);
    rememberImportNotes(created.id, file.filename, notes);
    toast.dismiss(working);
    navigate(path);
    return created;
  } catch (e) {
    toast.dismiss(working);
    toast.error(apiErrorMessage(e, "Couldn't open that spreadsheet as a sheet."));
    return null;
  }
}
