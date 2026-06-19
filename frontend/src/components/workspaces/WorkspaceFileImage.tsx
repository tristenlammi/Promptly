import { useEffect, useState } from "react";

import { apiClient } from "@/api/client";
import { filesApi } from "@/api/files";
import { cn } from "@/utils/cn";

/**
 * Renders a server-resized thumbnail for an image ``UserFile`` by fetching it
 * as an authed blob → object URL (the thumbnail endpoint needs the auth
 * header, so a plain ``<img src>`` won't work). Falls back to ``null`` on
 * failure so callers can hide the slot. Used for card cover images and the
 * attachment list.
 */
export function WorkspaceFileImage({
  fileId,
  alt,
  className,
}: {
  fileId: string;
  alt?: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    apiClient
      .get<Blob>(filesApi.thumbnailUrl(fileId).replace(/^\/api/, ""), {
        responseType: "blob",
      })
      .then((res) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId]);

  if (failed) return null;
  if (!url)
    return (
      <div className={cn("animate-pulse bg-[var(--hover)]", className)} />
    );
  return <img src={url} alt={alt ?? ""} className={className} />;
}
