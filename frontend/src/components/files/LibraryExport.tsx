import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, PackageOpen } from "lucide-react";

import { libraryExportApi } from "@/api/libraryExport";
import { humanSize } from "@/components/files/helpers";
import { Button } from "@/components/shared/Button";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

const SIZES = [2, 10, 50];

/** Export my library (WP-10.4): every file you own in its folders, photos
 *  with their details beside them, documents as Word files — in parts. */
export function LibraryExport() {
  const qc = useQueryClient();
  const { data: current, isLoading } = useQuery({
    queryKey: ["library-export"],
    queryFn: libraryExportApi.current,
    // Its download links are signed for a few hours: keep them fresh.
    refetchInterval: 30 * 60 * 1000,
  });
  const [partGb, setPartGb] = useState(10);
  const [making, setMaking] = useState(false);

  const make = async () => {
    setMaking(true);
    try {
      qc.setQueryData(["library-export"], await libraryExportApi.create(partGb));
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't prepare the export."));
    } finally {
      setMaking(false);
    }
  };

  return (
    <section aria-label="Export my library" className="mt-8 rounded-card border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        <PackageOpen className="h-4 w-4" /> Export my library
      </h2>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Everything you own as an ordinary folder tree: your files in their folders with their names and dates, documents
        as Word files, spreadsheets as Excel, and beside each photo its date, place, description and albums (as .json and
        .xmp, which other photo apps read). Unzip every part into one place. Another Promptly can import it as “A folder of
        photos”.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          Parts of up to
          <select
            value={partGb}
            onChange={(e) => setPartGb(Number(e.target.value))}
            className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
          >
            {SIZES.map((g) => (
              <option key={g} value={g}>
                {g} GB
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant={current ? "secondary" : "primary"} loading={making} onClick={() => void make()}>
          {current ? "Prepare a new export" : "Prepare export"}
        </Button>
      </div>
      {!isLoading && current && (
        <div className="mt-4">
          <p className="text-xs text-[var(--text-muted)]">
            {current.counts.files.toLocaleString()} files · {current.counts.photos.toLocaleString()} photos and videos ·{" "}
            {humanSize(current.bytes)} · prepared {new Date(current.created * 1000).toLocaleString()} · links work until{" "}
            {new Date(current.expires * 1000).toLocaleDateString()}
          </p>
          <ul className="mt-2 divide-y divide-[var(--border)] rounded-md border border-[var(--border)]" aria-label="Export parts">
            {current.parts.map((p) => (
              <li key={p.n} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {p.name}
                  <span className="block text-xs text-[var(--text-muted)]">
                    {p.files.toLocaleString()} {p.files === 1 ? "file" : "files"} · about {humanSize(p.bytes)}
                  </span>
                </span>
                <a
                  href={p.url}
                  download={p.name}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--accent-text)] hover:bg-[var(--hover)]"
                >
                  <Download className="h-3.5 w-3.5" /> Download
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            Each part is put together as it downloads, so the size shown is approximate. If a download stops, start that
            part again.
          </p>
        </div>
      )}
    </section>
  );
}
