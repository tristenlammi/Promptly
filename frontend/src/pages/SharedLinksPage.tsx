import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Globe, Lock, Trash2 } from "lucide-react";
import { useState } from "react";

import { filesApi, type OwnedShareLink } from "@/api/files";
import { DriveEmptyState } from "@/components/files/DriveSimpleList";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { extractError, formatRelativeTime } from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";

export const OWNED_LINKS_KEY = ["file-share-links", "mine"] as const;

/** Every live "anyone with the link" share you've made, in one place, with
 *  how often it was opened — so a link can be found and revoked from Drive
 *  instead of living on invisibly (R-208). */
export function SharedLinksPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: OWNED_LINKS_KEY,
    queryFn: () => filesApi.listMyShareLinks(),
  });
  const links = data?.links ?? [];

  const revoke = async (l: OwnedShareLink) => {
    const ok = await confirm({
      title: "Turn off this link?",
      message: `Anyone using it loses access to “${l.resource_name ?? "this item"}”. You can make a new link later.`,
      confirmLabel: "Turn off",
      danger: true,
    });
    if (!ok) return;
    try {
      await filesApi.revokeShareLink(l.id);
      void qc.invalidateQueries({ queryKey: ["file-share-links"] });
      void qc.invalidateQueries({ queryKey: ["folder-share-links"] });
      void qc.invalidateQueries({ queryKey: ["files-browse"] });
      toast.success("Link turned off");
    } catch (e) {
      toast.error(extractError(e));
    }
  };

  return (
    <>
      <TopNav
        title="Shared links"
        subtitle="Links that let anyone open a file or folder."
        actions={<FilesTopNavSearch />}
      />
      <DriveSubNav />
      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
          {isLoading && <div className="text-sm text-[var(--text-muted)]">Loading…</div>}
          {!isLoading && links.length === 0 && (
            <DriveEmptyState
              icon={<Globe className="h-5 w-5" />}
              title="No shared links"
              description="Make one from Share → Anyone with the link on any file or folder."
            />
          )}
          {links.length > 0 && (
            <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
              {links.map((l) => (
                <LinkRow key={l.id} link={l} onRevoke={() => void revoke(l)} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function LinkRow({ link, onRevoke }: { link: OwnedShareLink; onRevoke: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}${link.path}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy the link");
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      {link.access_mode === "public" ? (
        <Globe className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      ) : (
        <Lock className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-[var(--text)]">
          {link.resource_name ?? "(deleted item)"}
          {link.resource_trashed && (
            <span className="ml-2 text-xs text-[var(--warning)]">in trash</span>
          )}
        </div>
        <div className="text-xs text-[var(--text-muted)]">
          {link.resource_type === "folder" ? "Folder" : link.resource_type === "album" ? "Album" : "File"}
          {link.has_password ? " · password" : ""}
          {link.expires_at ? ` · expires ${formatRelativeTime(link.expires_at)}` : " · no expiry"}
          {` · opened ${link.access_count} time${link.access_count === 1 ? "" : "s"}`}
          {link.last_accessed_at ? ` (last ${formatRelativeTime(link.last_accessed_at)})` : ""}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--hover)]"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy link"}
      </button>
      <button
        type="button"
        onClick={onRevoke}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--danger)] hover:bg-[var(--danger-bg)]"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Turn off
      </button>
    </li>
  );
}
