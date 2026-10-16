import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import { filesApi } from "@/api/files";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { openFile } from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { ErrorState } from "@/components/shared/Callout";

/**
 * ``/files/f/:id`` — a link to any file you can open (Part C §2.2). Office
 * files go straight to their editor; anything else opens in the preview,
 * and closing it lands in the file's folder.
 *
 * Chat citations (WP-5.2) add where to look — ``?page=`` (a PDF), ``?tab=
 * &row=`` (a sheet), ``?q=`` (a document's find bar) — which is passed on
 * to the editor or preview.
 */
export function FileDeepLinkPage() {
  const { fileId = "" } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const { search } = useLocation();
  const page = Number(new URLSearchParams(search).get("page")) || undefined;
  const { data: file, error, isLoading } = useQuery({
    queryKey: ["file", fileId],
    queryFn: () => filesApi.getFile(fileId),
    retry: false,
  });
  useEffect(() => {
    if (file) openFile(file, (to) => navigate(to + search, { replace: true }));
  }, [file, navigate, search]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening…
      </div>
    );
  }
  if (error || !file) {
    return (
      <>
        <TopNav title="Not available" />
        <div className="mx-auto w-full max-w-xl px-4 py-10">
          <ErrorState>
            This file isn’t available — it may have been deleted or is no longer shared with you.{" "}
            <Link to="/files" className="font-medium underline">
              Back to Files
            </Link>
          </ErrorState>
        </div>
      </>
    );
  }
  const mine = file.scope === "mine";
  return (
    <FilePreviewModal
      open
      file={file}
      initialPage={page}
      onClose={() =>
        navigate(mine ? (file.folder_id ? `/files/folder/${file.folder_id}` : "/files") : "/files/shared", {
          replace: true,
        })
      }
    />
  );
}
