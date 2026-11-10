import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownUp, ArrowLeft, BookImage, Download, ImageMinus, ImagePlus, LogOut, MoreHorizontal, PauseCircle, Plus, Send, Share2, Sparkles, Star, Trash2, Upload } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { usePhotosPath } from "@/components/photos/photosPath";
import { albumsApi, type Album, type AlbumPhoto } from "@/api/albums";
import { filesApi } from "@/api/files";
import { trashApi } from "@/api/trash";
import { AlbumMembersDialog, Cover } from "@/components/photos/AlbumDialogs";
import { uploadToAlbum } from "@/components/photos/albumUploads";
import { NameDialog } from "@/components/photos/NameDialog";
import { usePhotosDrop } from "@/components/photos/photosDrop";
import { CardGridSkeleton, TileGridSkeleton } from "@/components/photos/PhotoSkeletons";
import { PhotoTile } from "@/components/photos/PhotoTile";
import { PopMenu, PopMenuItem } from "@/components/photos/PopMenu";
import { SelectionBar, type SelectionAction } from "@/components/photos/SelectionBar";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { SendToSheet } from "@/components/share/SendToSheet";
import { EntityTags } from "@/components/tags/TagPicker";
import { LinkedSection } from "@/components/links/LinkedSection";
import { SmartAlbumDialog } from "@/components/photos/SmartAlbumDialog";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { Skeleton } from "@/components/shared/Skeleton";
import { justify } from "@/lib/justify";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** Albums (WP-9.4): your albums and the ones shared with you; an album's
 *  photos, its people, adding and taking out. */

export function PhotoAlbumsPage() {
  const photosPath = usePhotosPath();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: albums, isLoading } = useQuery({ queryKey: ["albums"], queryFn: albumsApi.list });
  const [smart, setSmart] = useState(false);
  const [naming, setNaming] = useState(false);
  const make = async (title: string) => {
    try {
      const a = await albumsApi.create(title);
      void qc.invalidateQueries({ queryKey: ["albums"] });
      setNaming(false);
      navigate(photosPath(`/albums/${a.id}`));
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't make the album."));
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <h1 className="flex-1 text-base font-semibold text-[var(--text)]">Albums</h1>
        <Button size="sm" variant="ghost" leftIcon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => setSmart(true)}>
          New smart album
        </Button>
        <Button size="sm" variant="secondary" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setNaming(true)}>
          New album
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <CardGridSkeleton label="Loading your albums" />
        ) : !albums?.length ? (
          <div className="mx-auto max-w-lg pt-6">
            <EmptyState
              icon={<BookImage className="h-5 w-5" />}
              title="No albums yet"
              description="Gather photos of a trip, a person or a year. Share an album and your family can add theirs."
              action={
                <Button size="sm" variant="primary" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => setNaming(true)}>
                  New album
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5" aria-label="Albums">
            {albums.map((a) => (
              <li key={a.id}>
                <Link to={photosPath(`/albums/${a.id}`)} className="group block">
                  <div className="overflow-hidden rounded-lg transition group-hover:opacity-90">
                    <Cover album={a} />
                  </div>
                  <p className="mt-1.5 truncate text-sm font-medium text-[var(--text)]">{a.title}</p>
                  <p className="truncate text-xs text-[var(--text-muted)]">
                    {a.smart && <Sparkles className="mr-1 inline h-3 w-3" aria-label="Smart album" />}
                    {a.count} {a.count === 1 ? "item" : "items"}
                    {a.role !== "owner" ? ` · from ${a.owner.username}` : a.shared ? " · shared" : ""}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      {naming && (
        <NameDialog title="New album" label="Album name" placeholder="Summer holiday" onClose={() => setNaming(false)} onSubmit={make} />
      )}
      {smart && (
        <SmartAlbumDialog
          onClose={() => setSmart(false)}
          onSave={async (title, rules) => {
            try {
              const a = await albumsApi.create(title, [], { rules });
              void qc.invalidateQueries({ queryKey: ["albums"] });
              setSmart(false);
              navigate(photosPath(`/albums/${a.id}`));
            } catch (e) {
              toast.error(apiErrorMessage(e, "Couldn't make the album."));
            }
          }}
        />
      )}
    </div>
  );
}

/** The width of an element that may appear later (after loading) — a
 *  callback ref, so the measuring starts whenever it does. */
function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}

export function PhotoAlbumPage() {
  const photosPath = usePhotosPath();
  const { albumId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: album, error } = useQuery({ queryKey: ["album", albumId], queryFn: () => albumsApi.get(albumId) });
  const pages = useInfiniteQuery({
    queryKey: ["album", albumId, "items"],
    queryFn: ({ pageParam }) => albumsApi.items(albumId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
  const items = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const [boxRef, width] = useWidth();
  const rows = useMemo(
    () => justify(items.map((p) => ({ aspect: p.width && p.height ? p.width / p.height : null })), { width, targetHeight: width < 640 ? 110 : 200, gap: 4 }),
    [items, width],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sharing, setSharing] = useState(false);
  const [sending, setSending] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && pages.hasNextPage && void pages.fetchNextPage());
    io.observe(el);
    return () => io.disconnect();
  }, [pages]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["album", albumId] });
    void qc.invalidateQueries({ queryKey: ["albums"] });
  };

  // Photos dropped on the page go into this album (through the upload
  // queue, so each one shows its progress).
  const mayAdd = !!album && album.role !== "viewer";
  usePhotosDrop(
    mayAdd && album
      ? { label: `Drop to add to “${album.title}”`, onFiles: (files) => uploadToAlbum(album, files, qc) }
      : null,
  );

  if (error) {
    return <p className="p-6 text-sm text-[var(--text-muted)]">This album isn't there, or it isn't shared with you.</p>;
  }
  if (!album) {
    return (
      <div role="status" aria-label="Loading the album" className="flex h-full min-h-0 flex-col">
        <div className="border-b border-[var(--border)] px-4 py-3">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-2 h-3 w-24" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden p-2 sm:p-4">
          <TileGridSkeleton rows={4} tile={160} />
        </div>
      </div>
    );
  }
  const owner = album.role === "owner";
  const canAdd = album.role !== "viewer";
  const chosen = items.filter((p) => selected.has(p.id));
  const removable = chosen.filter((p) => owner || p.mine);

  const toggle = (p: { id: string }) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(p.id)) n.delete(p.id);
      else n.add(p.id);
      return n;
    });

  // Into your own Photos folder (by date), then into the album.
  const upload = (files: FileList | null) => uploadToAlbum(album, Array.from(files ?? []), qc);

  const clear = () => setSelected(new Set());
  const actions: SelectionAction[] = [
    ...(owner && selected.size === 1
      ? [{
          key: "cover",
          label: "Make cover",
          icon: <Star />,
          onClick: () =>
            void albumsApi
              .update(album.id, { cover_file_id: [...selected][0] })
              .then(() => {
                toast.success("That's the cover now.");
                clear();
                refresh();
              })
              .catch((e) => toast.error(apiErrorMessage(e, "Couldn't change the cover."))),
        }]
      : []),
    {
      key: "download",
      label: "Download",
      icon: <Download />,
      onClick: () => void filesApi.bulkZipDownload({ file_ids: [...selected], folder_ids: [] }).catch((e) => toast.error(apiErrorMessage(e, "Couldn't download them."))),
    },
    ...(removable.length > 0
      ? [{
          key: "remove",
          label: "Remove from album",
          icon: <ImageMinus />,
          onClick: () => {
            const ids = removable.map((p) => p.id);
            void albumsApi
              .removeItems(album.id, ids)
              .then((n) => {
                // Still in Photos; one tap puts them back in the album.
                toast.success(`Took ${n} out of the album. ${n === 1 ? "It's" : "They're"} still in Photos.`, {
                  action: { label: "Undo", onClick: () => void albumsApi.addItems(album.id, ids).then(refresh).catch((e) => toast.error(apiErrorMessage(e))) },
                });
                clear();
                refresh();
              })
              .catch((e) => toast.error(apiErrorMessage(e, "Couldn't take them out.")));
          },
        }]
      : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        {/* A selection's actions float over the grid (below), so the header
            stays where it is. */}
        <>
            <Link to={photosPath("/albums")} aria-label="Back to albums" title="Back to albums" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-[var(--hover)] sm:h-8 sm:w-8">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              {owner ? (
                <input
                  aria-label="Album name"
                  defaultValue={album.title}
                  key={album.title}
                  onBlur={(e) => {
                    const t = e.target.value.trim();
                    if (t && t !== album.title) void albumsApi.update(album.id, { title: t }).then(refresh);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className="w-full truncate rounded bg-transparent px-1 text-base font-semibold text-[var(--text)] outline-none hover:bg-[var(--hover)] focus:bg-[var(--hover)]"
                />
              ) : (
                <h1 className="truncate px-1 text-base font-semibold text-[var(--text)]">{album.title}</h1>
              )}
              <p className="px-1 text-xs text-[var(--text-muted)]">
                {album.count} {album.count === 1 ? "item" : "items"}
                {!owner && ` · ${album.owner.username}'s album`}
                {album.members?.length ? ` · ${album.members.length + 1} people` : ""}
                {album.smart && (
                  <span title="New photos that match join it by themselves">
                    {" · "}<Sparkles className="inline h-3 w-3" aria-hidden /> Smart: {album.smart.summary}
                  </span>
                )}
              </p>
              <EntityTags kind="album" id={album.id} className="mt-1 max-w-md px-1" />
              <LinkedSection thing={{ kind: "album", id: album.id }} className="mt-2 max-w-md px-1" />
            </div>
            {canAdd && (
              <>
                <Button size="sm" variant="secondary" leftIcon={<ImagePlus className="h-3.5 w-3.5" />} onClick={() => navigate(photosPath(`?addTo=${album.id}`))}>
                  Add photos
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept="image/*,video/*,.heic,.heif,.dng,.mov"
                  hidden
                  onChange={(e) => {
                    upload(e.target.files);
                    e.target.value = "";
                  }}
                />
                <Button size="sm" variant="ghost" leftIcon={<Upload className="h-3.5 w-3.5" />} onClick={() => fileInput.current?.click()}>
                  Upload
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" leftIcon={<Share2 className="h-3.5 w-3.5" />} onClick={() => setSharing(true)}>
              {owner ? "Share" : "People"}
            </Button>
            <Button size="sm" variant="ghost" leftIcon={<Send className="h-3.5 w-3.5" />} onClick={() => setSending(true)}>
              Send to…
            </Button>
            <button
              ref={menuButton}
              type="button"
              aria-label="More"
              title="More"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
              className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-[var(--hover)] sm:h-8 sm:w-8"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            <PopMenu open={menu} anchor={menuButton} onClose={() => setMenu(false)} label="More for this album">
                  {owner && (
                    <PopMenuItem icon={<ArrowDownUp className="h-4 w-4" />} onSelect={() => {
                      setMenu(false);
                      void albumsApi.update(album.id, { sort: album.sort === "newest" ? "oldest" : "newest" }).then(refresh);
                    }}>
                      {album.sort === "newest" ? "Oldest first" : "Newest first"}
                    </PopMenuItem>
                  )}
                  {owner && (
                    <PopMenuItem icon={<Sparkles className="h-4 w-4" />} onSelect={() => {
                      setMenu(false);
                      setEditing(true);
                    }}>
                      {album.smart ? "Edit what it holds" : "Make it smart"}
                    </PopMenuItem>
                  )}
                  {owner && album.smart && (
                    <PopMenuItem icon={<PauseCircle className="h-4 w-4" />} onSelect={async () => {
                      setMenu(false);
                      if (!(await confirm({ title: "Stop adding photos by itself?", message: "What's in it now stays; new photos won't join.", confirmLabel: "Stop" }))) return;
                      await albumsApi.setRules(album.id, null);
                      refresh();
                    }}>
                      Stop updating
                    </PopMenuItem>
                  )}
                  {owner ? (
                    <PopMenuItem danger icon={<Trash2 className="h-4 w-4" />} onSelect={async () => {
                      setMenu(false);
                      if (!(await confirm({ title: `Delete “${album.title}”?`, message: "The photos stay in Photos and Files — only the album goes.", confirmLabel: "Delete album", danger: true }))) return;
                      await albumsApi.remove(album.id);
                      void qc.invalidateQueries({ queryKey: ["albums"] });
                      navigate(photosPath("/albums"));
                      // It went to the Trash — one tap brings it back.
                      const albumId = album.id;
                      toast.success("Album deleted", {
                        action: {
                          label: "Undo",
                          onClick: () =>
                            void trashApi
                              .restore([{ type: "album", id: albumId }])
                              .then((r) => {
                                if (!r.done) toast.error(r.results[0]?.error || "Couldn't bring it back.");
                                void qc.invalidateQueries({ queryKey: ["albums"] });
                              })
                              .catch((e) => toast.error(apiErrorMessage(e))),
                        },
                      });
                    }}>
                      Delete album
                    </PopMenuItem>
                  ) : (
                    <PopMenuItem icon={<LogOut className="h-4 w-4" />} onSelect={async () => {
                      setMenu(false);
                      if (!(await confirm({ title: `Leave “${album.title}”?`, message: "Photos you added leave with you.", confirmLabel: "Leave", danger: true }))) return;
                      const me = useAuthStore.getState().user?.id;
                      if (!me) return;
                      await albumsApi.removeMember(album.id, me);
                      void qc.invalidateQueries({ queryKey: ["albums"] });
                      navigate(photosPath("/albums"));
                    }}>
                      Leave album
                    </PopMenuItem>
                  )}
            </PopMenu>
          </>
      </header>
      <div className="relative min-h-0 flex-1">
      <SelectionBar count={selected.size} onClear={clear} actions={actions} escape={!viewing && !sharing && !sending && !editing} />
      <div className="h-full overflow-y-auto p-2 sm:p-4">
        <div ref={boxRef}>
          {pages.isLoading ? (
            <div role="status" aria-label="Loading the photos">
              <TileGridSkeleton rows={4} tile={width < 640 ? 110 : 200} />
            </div>
          ) : items.length === 0 ? (
            <div className="mx-auto max-w-lg pt-6">
              <EmptyState
                icon={<ImagePlus className="h-5 w-5" />}
                title="Nothing here yet"
                description={canAdd ? "Add photos from your library, upload from this device, or drop them here." : "Photos added to this album show up here."}
                action={
                  canAdd ? (
                    <Button size="sm" variant="primary" leftIcon={<ImagePlus className="h-3.5 w-3.5" />} onClick={() => navigate(photosPath(`?addTo=${album.id}`))}>
                      Add photos
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {rows.map((r, ri) => (
                <div key={ri} className="flex gap-1" style={{ height: r.height }}>
                  {r.items.map((idx, k) => {
                    const p = items[idx];
                    return (
                      <PhotoTile
                        key={p.id}
                        photo={p}
                        width={r.widths[k]}
                        height={r.height}
                        selected={selected.has(p.id)}
                        selecting={selected.size > 0}
                        onToggle={toggle}
                        onOpen={(ph) => setViewing(ph.id)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          <div ref={sentinel} className="h-8" />
        </div>
      </div>
      </div>
      {sharing && <AlbumMembersDialog album={album} onClose={() => setSharing(false)} />}
      <SendToSheet open={sending} onClose={() => setSending(false)} target={{ kind: "album", id: album.id, title: album.title }} canGrant={owner} />
      {editing && (
        <SmartAlbumDialog
          initial={album.smart?.rules}
          title={album.title}
          onClose={() => setEditing(false)}
          onSave={async (title, rules) => {
            try {
              if (title !== album.title) await albumsApi.update(album.id, { title });
              await albumsApi.setRules(album.id, rules);
              setEditing(false);
              refresh();
            } catch (e) {
              toast.error(apiErrorMessage(e, "Couldn't change the album."));
            }
          }}
        />
      )}
      {viewing && (
        <PhotoViewer
          items={items}
          startId={viewing}
          loadMore={async (dir) => {
            if (dir !== 1 || !pages.hasNextPage) return [];
            const res = await pages.fetchNextPage();
            const all = res.data?.pages.flatMap((p) => p.items) ?? [];
            return all.slice(items.length) as AlbumPhoto[];
          }}
          onClose={() => {
            setViewing(null);
            refresh();
          }}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

export type { Album };
