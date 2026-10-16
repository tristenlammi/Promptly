import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Plus, Users, X } from "lucide-react";

import { albumsApi, type Album } from "@/api/albums";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { UserPicker, type UserPickerValue } from "@/components/shared/UserPicker";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** "Add to album" (WP-9.4): one you can add to, or a new one. Only your own
 *  photos go in — the server skips any that aren't. */
export function AddToAlbumDialog({
  fileIds,
  onClose,
  onDone,
}: {
  fileIds: string[];
  onClose: () => void;
  onDone: (album: { id: string; title: string }, added: number) => void;
}) {
  const qc = useQueryClient();
  const { data: albums = [] } = useQuery({ queryKey: ["albums"], queryFn: albumsApi.list });
  const writable = albums.filter((a) => a.role !== "viewer");
  const [title, setTitle] = useState("");
  const add = useMutation({
    mutationFn: async (target: { id?: string; title: string }) => {
      if (target.id) return { album: { id: target.id, title: target.title }, added: await albumsApi.addItems(target.id, fileIds) };
      const made = await albumsApi.create(target.title, fileIds);
      return { album: { id: made.id, title: made.title }, added: made.count };
    },
    onSuccess: async ({ album, added }) => {
      // A list still loading from before the new album would otherwise be
      // kept: the first load of a query isn't restarted by invalidation.
      await qc.cancelQueries({ queryKey: ["albums"] });
      void qc.invalidateQueries({ queryKey: ["albums"] });
      void qc.invalidateQueries({ queryKey: ["album", album.id] });
      onDone(album, added);
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't add them.")),
  });
  return (
    <Modal open onClose={onClose} title={`Add ${fileIds.length} to an album`} widthClass="max-w-md">
      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) add.mutate({ title: title.trim() });
        }}
      >
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          aria-label="New album name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New album — e.g. Holiday 2026"
          maxLength={200}
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
        />
        <Button type="submit" size="sm" variant="primary" disabled={!title.trim()} loading={add.isPending} leftIcon={<Plus className="h-3.5 w-3.5" />}>
          Create
        </Button>
      </form>
      {writable.length > 0 && (
        <ul aria-label="Your albums" className="max-h-72 divide-y divide-[var(--border)] overflow-y-auto rounded-md border border-[var(--border)]">
          {writable.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                disabled={add.isPending}
                onClick={() => add.mutate({ id: a.id, title: a.title })}
                className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--hover)]"
              >
                <Cover album={a} size={40} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[var(--text)]">{a.title}</span>
                  <span className="block text-xs text-[var(--text-muted)]">
                    {a.count} {a.count === 1 ? "item" : "items"}
                    {a.role === "contributor" ? ` · ${a.owner.username}'s` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function Cover({ album, size }: { album: Album; size?: number }) {
  const style = size ? { width: size, height: size } : undefined;
  return album.cover?.thumb ? (
    <img src={album.cover.thumb} alt="" style={style} className="aspect-square shrink-0 rounded-md object-cover" />
  ) : (
    <span style={style} className="flex aspect-square shrink-0 items-center justify-center rounded-md bg-[var(--hover)] text-[var(--text-muted)]">
      <Users className="h-4 w-4" />
    </span>
  );
}

/** Who's in an album, and (for its owner) adding and removing people. */
export function AlbumMembersDialog({ album, onClose }: { album: Album; onClose: () => void }) {
  const qc = useQueryClient();
  const [who, setWho] = useState<UserPickerValue>(null);
  const [role, setRole] = useState<"viewer" | "contributor">("contributor");
  const owner = album.role === "owner";
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["album", album.id] });
    void qc.invalidateQueries({ queryKey: ["albums"] });
  };
  const add = useMutation({
    mutationFn: () => {
      if (who?.kind !== "user") throw new Error("Pick someone from the list.");
      return albumsApi.addMember(album.id, who.user.user_id, role);
    },
    onSuccess: () => {
      setWho(null);
      refresh();
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't add them.")),
  });
  const members = album.members ?? [];
  return (
    <Modal open onClose={onClose} title={`Share “${album.title}”`} widthClass="max-w-md">
      {owner && (
        <div className="mb-4 space-y-2">
          <UserPicker
            value={who}
            onChange={setWho}
            excludeUserIds={members.map((m) => m.user_id)}
            placeholder="Add someone by name or email"
            onSubmit={() => add.mutate()}
          />
          <div className="flex items-center gap-2">
            <select
              aria-label="What they can do"
              value={role}
              onChange={(e) => setRole(e.target.value as "viewer" | "contributor")}
              className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs"
            >
              <option value="contributor">Can add photos</option>
              <option value="viewer">Can look</option>
            </select>
            <Button size="sm" variant="primary" disabled={who?.kind !== "user"} loading={add.isPending} onClick={() => add.mutate()}>
              Add
            </Button>
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">
            People in the album see every photo in it, with its location. Photos they add stay in their own Files and
            count against their own storage.
          </p>
        </div>
      )}
      {owner && <AlbumLinks albumId={album.id} />}
      <ul aria-label="People in this album" className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)] text-sm">
        <li className="flex items-center gap-2 px-3 py-2">
          <span className="flex-1 font-medium">{album.owner.username}</span>
          <span className="text-xs text-[var(--text-muted)]">Owner</span>
        </li>
        {members.map((m) => (
          <li key={m.user_id} className="flex items-center gap-2 px-3 py-2">
            <span className="flex-1">{m.username}</span>
            {owner ? (
              <>
                <select
                  aria-label={`What ${m.username} can do`}
                  value={m.role}
                  onChange={(e) =>
                    void albumsApi
                      .setRole(album.id, m.user_id, e.target.value as "viewer" | "contributor")
                      .then(refresh)
                      .catch((err) => toast.error(apiErrorMessage(err, "Couldn't change that.")))
                  }
                  className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-xs"
                >
                  <option value="contributor">Can add photos</option>
                  <option value="viewer">Can look</option>
                </select>
                <button
                  type="button"
                  aria-label={`Remove ${m.username}`}
                  onClick={() =>
                    void albumsApi
                      .removeMember(album.id, m.user_id)
                      .then(refresh)
                      .catch((err) => toast.error(apiErrorMessage(err, "Couldn't remove them.")))
                  }
                  className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <span className="text-xs text-[var(--text-muted)]">{m.role === "contributor" ? "Can add photos" : "Can look"}</span>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Anyone with the link can look — no account, and without the photos'
 *  location unless that link includes it (WP-9.5). */
function AlbumLinks({ albumId }: { albumId: string }) {
  const qc = useQueryClient();
  const key = ["album", albumId, "links"];
  const { data: links = [] } = useQuery({ queryKey: key, queryFn: () => albumsApi.links(albumId) });
  const [location, setLocation] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const make = useMutation({
    mutationFn: () => albumsApi.createLink(albumId, location),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't make a link.")),
  });
  return (
    <section aria-label="Album link" className="mb-4 space-y-2 rounded-md border border-[var(--border)] p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
        <Link2 className="h-3.5 w-3.5" /> Anyone with the link
      </p>
      {links.map((l) => {
        const url = `${window.location.origin}${l.path}`;
        return (
          <div key={l.id} className="flex items-start gap-3">
            <img src={l.qr} alt="QR code for the album link" className="h-20 w-20 shrink-0 rounded bg-white p-1" />
            <div className="min-w-0 flex-1 space-y-1 text-xs">
              <code aria-label="Album link" className="block truncate rounded bg-[var(--bg)] px-2 py-1 font-mono">{url}</code>
              <p className="text-[var(--text-muted)]">
                {l.keep_location ? "Includes where photos were taken" : "Without where photos were taken"} · opened {l.access_count}{" "}
                {l.access_count === 1 ? "time" : "times"}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard?.writeText(url).then(() => {
                      setCopied(l.id);
                      window.setTimeout(() => setCopied(null), 1500);
                    })
                  }
                  className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--hover)]"
                >
                  {copied === l.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Copy link
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void albumsApi
                      .revokeLink(albumId, l.id)
                      .then(() => qc.invalidateQueries({ queryKey: key }))
                      .catch((err) => toast.error(apiErrorMessage(err, "Couldn't turn it off.")))
                  }
                  className="rounded px-2 py-0.5 text-red-500 hover:bg-[var(--hover)]"
                >
                  Turn off
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {links.length === 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <input type="checkbox" checked={location} onChange={(e) => setLocation(e.target.checked)} className="accent-[var(--accent)]" />
            Include where photos were taken
          </label>
          <Button size="sm" variant="secondary" loading={make.isPending} onClick={() => make.mutate()}>
            Make a link
          </Button>
        </div>
      )}
    </section>
  );
}
