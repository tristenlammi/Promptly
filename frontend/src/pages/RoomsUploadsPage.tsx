import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Film, MessagesSquare, Mic, Music, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { roomsApi, type MyRoomUpload } from "@/api/rooms";
import { DriveListSkeleton } from "@/components/files/DriveListSkeleton";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { extractError, formatRelativeTime, humanSize } from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { toast } from "@/store/toastStore";

/**
 * Files → Rooms uploads: the files you've sent in Rooms. They use your
 * storage, so this is where you see what they add up to and remove the ones
 * you no longer want kept.
 *
 * These are not Drive files. They stay with Rooms (nothing in Rooms is read
 * by AI), so they can't be moved, shared or searched from here: the list
 * comes from Rooms itself. Removing one takes the file away for everyone in
 * that conversation; its message stays and says "File removed".
 */
export function RoomsUploadsPage() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: ["rooms", "my-uploads"],
    queryFn: ({ pageParam }) => roomsApi.myUploads(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_before,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const first = q.data?.pages[0];

  const remove = async (u: MyRoomUpload) => {
    const ok = await confirm({
      title: `Remove ${label(u)}?`,
      message: u.sent
        ? `It will be gone for everyone in ${u.room}. The message stays and says "File removed". This can't be undone.`
        : "It was attached but not sent. This can't be undone.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusy(u.id);
    try {
      await roomsApi.removeUpload(u.id);
      toast.success("Removed");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["rooms", "my-uploads"] }),
        qc.invalidateQueries({ queryKey: ["files-storage"] }),
      ]);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <TopNav
        title="Rooms uploads"
        subtitle={
          first && first.count > 0
            ? `${first.count} file${first.count === 1 ? "" : "s"} you've sent in Rooms, using ${humanSize(first.bytes)} of your storage.`
            : "Files you've sent in Rooms."
        }
      />
      <DriveSubNav />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="w-full px-4 py-6 sm:px-6">
          <p className="mb-4 max-w-2xl text-sm text-[var(--text-muted)]">
            These stay with Rooms: they aren't part of your other files, AI never reads them, and the people you sent them to open them in
            the conversation. Removing one here takes it away for everyone; its message stays and says "File removed".
          </p>

          {q.isLoading && <DriveListSkeleton />}

          {!q.isLoading && items.length === 0 && (
            <EmptyState
              icon={<MessagesSquare className="h-5 w-5" />}
              title="Nothing sent in Rooms yet"
              description="Photos, videos and files you send in Rooms show up here, with how much of your storage they use."
            />
          )}

          {items.length > 0 && (
            <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              {items.map((u) => (
                <li key={u.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Thumb u={u} />
                  <div className="min-w-0 flex-1">
                    <a
                      href={u.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-sm font-medium text-[var(--text)] hover:underline"
                    >
                      {label(u)}
                    </a>
                    <div className="truncate text-xs text-[var(--text-muted)]">
                      {u.sent ? (
                        <Link to={`/rooms/r/${u.room_id}`} className="hover:underline">
                          {u.room}
                        </Link>
                      ) : (
                        <span>Not sent yet · {u.room}</span>
                      )}
                      {" · "}
                      {humanSize(u.size)}
                      {u.created_at ? ` · ${formatRelativeTime(u.created_at)}` : ""}
                    </div>
                  </div>
                  <a
                    href={u.url}
                    download={u.filename}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Download ${label(u)}`}
                    title="Download"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <Download className="h-4 w-4" />
                  </a>
                  <button
                    type="button"
                    onClick={() => void remove(u)}
                    disabled={busy === u.id}
                    aria-label={`Remove ${label(u)}`}
                    title="Remove"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)] disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {q.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button size="sm" variant="secondary" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? "Loading…" : "Show more"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function label(u: MyRoomUpload): string {
  return u.voice ? "Voice message" : u.filename;
}

function Thumb({ u }: { u: MyRoomUpload }) {
  const box = "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--surface-2)] text-[var(--text-muted)]";
  if (u.thumb_url) {
    return (
      <span className={box}>
        <img src={u.thumb_url} alt="" loading="lazy" className="h-full w-full object-cover" />
      </span>
    );
  }
  const Icon = u.voice ? Mic : u.mime.startsWith("video/") ? Film : u.mime.startsWith("audio/") ? Music : FileText;
  return (
    <span className={box}>
      <Icon className="h-5 w-5" />
    </span>
  );
}
