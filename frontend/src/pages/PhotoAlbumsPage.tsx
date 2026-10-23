import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, ImagePlus, LogOut, MoreHorizontal, Plus, Share2, Sparkles, Star, Trash2, Upload, Users, X } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { albumsApi, type Album, type AlbumPhoto } from "@/api/albums";
import { filesApi } from "@/api/files";
import { AlbumMembersDialog, Cover } from "@/components/photos/AlbumDialogs";
import { PhotoTile } from "@/components/photos/PhotoTile";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { SmartAlbumDialog } from "@/components/photos/SmartAlbumDialog";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { justify } from "@/lib/justify";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** Albums (WP-9.4): your albums and the ones shared with you; an album's
 *  photos, its people, adding and taking out. */

export function PhotoAlbumsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: albums, isLoading } = useQuery({ queryKey: ["albums"], queryFn: albumsApi.list });
  const [smart, setSmart] = useState(false);
  const make = async () => {
    const title = window.prompt("Name the album", "");
    if (!title?.trim()) return;
    try {
      const a = await albumsApi.create(title.trim());
      void qc.invalidateQueries({ queryKey: ["albums"] });
      navigate(`/files/photos/albums/${a.id}`);
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
        <Button size="sm" variant="secondary" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => void make()}>
          New album
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <p className="text-sm text-[var(--text-muted)]">Loading…</p>
        ) : !albums?.length ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <Users className="h-10 w-10 text-[var(--text-muted)]" />
            <p className="text-sm font-medium text-[var(--text)]">No albums yet</p>
            <p className="max-w-sm text-xs text-[var(--text-muted)]">
              Select photos in Photos and choose Add to album — or make one here and share it, so family can add theirs.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5" aria-label="Albums">
            {albums.map((a) => (
              <li key={a.id}>
                <Link to={`/files/photos/albums/${a.id}`} className="group block">
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
      {smart && (
        <SmartAlbumDialog
          onClose={() => setSmart(false)}
          onSave={async (title, rules) => {
            try {
              const a = await albumsApi.create(title, [], { rules });
              void qc.invalidateQueries({ queryKey: ["albums"] });
              setSmart(false);
              navigate(`/files/photos/albums/${a.id}`);
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
  const [viewing, setViewing] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
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

  if (error) {
    return <p className="p-6 text-sm text-[var(--text-muted)]">This album isn't there, or it isn't shared with you.</p>;
  }
  if (!album) return <p className="p-6 text-sm text-[var(--text-muted)]">Loading…</p>;
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

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const ids: string[] = [];
    toast.info(`Uploading ${files.length}…`);
    for (const f of Array.from(files)) {
      try {
        // Into your own Photos folder (by date), then into the album.
        ids.push((await filesApi.upload("mine", f, null, "camera")).id);
      } catch (e) {
        toast.error(`${f.name}: ${apiErrorMessage(e, "couldn't upload")}`);
      }
    }
    if (ids.length) {
      const n = await albumsApi.addItems(album.id, ids);
      toast.success(`Added ${n} to “${album.title}”.`);
      refresh();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        {selected.size > 0 ? (
          <div role="toolbar" aria-label="Selected photos" className="flex w-full flex-wrap items-center gap-1">
            <button type="button" aria-label="Clear selection" onClick={() => setSelected(new Set())} className="rounded p-1 hover:bg-[var(--hover)]">
              <X className="h-4 w-4" />
            </button>
            <span className="mr-2 text-sm font-medium">{selected.size} selected</span>
            {owner && selected.size === 1 && (
              <Button size="sm" variant="ghost" leftIcon={<Star className="h-3.5 w-3.5" />} onClick={() =>
                void albumsApi.update(album.id, { cover_file_id: [...selected][0] }).then(() => { toast.success("That's the cover now."); setSelected(new Set()); refresh(); })
              }>
                Make cover
              </Button>
            )}
            <Button size="sm" variant="ghost" leftIcon={<Download className="h-3.5 w-3.5" />} onClick={() =>
              void filesApi.bulkZipDownload({ file_ids: [...selected], folder_ids: [] }).catch((e) => toast.error(apiErrorMessage(e, "Couldn't download them.")))
            }>
              Download
            </Button>
            {removable.length > 0 && (
              <Button size="sm" variant="ghost" leftIcon={<Trash2 className="h-3.5 w-3.5" />} onClick={() =>
                void albumsApi.removeItems(album.id, removable.map((p) => p.id)).then((n) => {
                  toast.success(`Took ${n} out of the album — they're still in Photos.`);
                  setSelected(new Set());
                  refresh();
                })
              }>
                Remove from album
              </Button>
            )}
          </div>
        ) : (
          <>
            <Link to="/files/photos/albums" aria-label="Back to albums" className="rounded p-1 hover:bg-[var(--hover)]">
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
            </div>
            {canAdd && (
              <>
                <Button size="sm" variant="secondary" leftIcon={<ImagePlus className="h-3.5 w-3.5" />} onClick={() => navigate(`/files/photos?addTo=${album.id}`)}>
                  Add photos
                </Button>
                <input ref={fileInput} type="file" multiple accept="image/*,video/*,.heic,.heif" hidden onChange={(e) => void upload(e.target.files)} />
                <Button size="sm" variant="ghost" leftIcon={<Upload className="h-3.5 w-3.5" />} onClick={() => fileInput.current?.click()}>
                  Upload
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" leftIcon={<Share2 className="h-3.5 w-3.5" />} onClick={() => setSharing(true)}>
              {owner ? "Share" : "People"}
            </Button>
            <div className="relative">
              <button type="button" aria-label="More" aria-expanded={menu} onClick={() => setMenu((v) => !v)} className="rounded p-1.5 hover:bg-[var(--hover)]">
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {menu && (
                <div role="menu" className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 text-sm shadow-lg">
                  {owner && (
                    <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]" onClick={() => {
                      setMenu(false);
                      void albumsApi.update(album.id, { sort: album.sort === "newest" ? "oldest" : "newest" }).then(refresh);
                    }}>
                      {album.sort === "newest" ? "Oldest first" : "Newest first"}
                    </button>
                  )}
                  {owner && (
                    <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]" onClick={() => {
                      setMenu(false);
                      setEditing(true);
                    }}>
                      {album.smart ? "Edit what it holds" : "Make it smart"}
                    </button>
                  )}
                  {owner && album.smart && (
                    <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]" onClick={async () => {
                      setMenu(false);
                      if (!(await confirm({ title: "Stop adding photos by itself?", message: "What's in it now stays; new photos won't join.", confirmLabel: "Stop" }))) return;
                      await albumsApi.setRules(album.id, null);
                      refresh();
                    }}>
                      Stop updating
                    </button>
                  )}
                  {owner ? (
                    <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left text-red-500 hover:bg-[var(--hover)]" onClick={async () => {
                      setMenu(false);
                      if (!(await confirm({ title: `Delete “${album.title}”?`, message: "The photos stay in Photos and Files — only the album goes.", confirmLabel: "Delete album", danger: true }))) return;
                      await albumsApi.remove(album.id);
                      void qc.invalidateQueries({ queryKey: ["albums"] });
                      navigate("/files/photos/albums");
                    }}>
                      Delete album
                    </button>
                  ) : (
                    <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--hover)]" onClick={async () => {
                      setMenu(false);
                      if (!(await confirm({ title: `Leave “${album.title}”?`, message: "Photos you added leave with you.", confirmLabel: "Leave", danger: true }))) return;
                      const me = useAuthStore.getState().user?.id;
                      if (!me) return;
                      await albumsApi.removeMember(album.id, me);
                      void qc.invalidateQueries({ queryKey: ["albums"] });
                      navigate("/files/photos/albums");
                    }}>
                      <LogOut className="h-3.5 w-3.5" /> Leave album
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-4">
        <div ref={boxRef}>
          {items.length === 0 && !pages.isLoading ? (
            <p className="p-8 text-center text-sm text-[var(--text-muted)]">
              {canAdd ? "Nothing here yet — Add photos from your library, or Upload from this device." : "Nothing here yet."}
            </p>
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
      {sharing && <AlbumMembersDialog album={album} onClose={() => setSharing(false)} />}
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
