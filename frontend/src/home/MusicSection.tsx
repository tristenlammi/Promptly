import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { homeApi, type Home, type HomeBox, type MusicLink } from "@/api/home";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { musicSummary } from "./words";

/**
 * Music by name: "play Miles Davis in the lounge". The home's owner links a
 * streaming service here; the assistant then plays from it on the home's
 * speakers. Linking happens on the service's own site with a short code, so
 * no password is ever typed into Promptly. Everyone in the home sees what's
 * linked; only the owner or a co-owner links and unlinks.
 */

const btn =
  "inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-3 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const strong =
  "inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[var(--accent-strong)] px-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";

export function MusicSection({ home, box, owner }: { home: Home; box: HomeBox; owner: boolean }) {
  const qc = useQueryClient();
  const key = ["home", "music", home.id, box.id];
  const status = useQuery({ queryKey: key, queryFn: () => homeApi.music(home.id, box.id), enabled: box.online && box.ready });
  const [link, setLink] = useState<MusicLink | null>(null);
  const again = () => void qc.invalidateQueries({ queryKey: key });

  const start = useMutation({
    mutationFn: (brand: string) => homeApi.musicLink(home.id, box.id, brand),
    onSuccess: (step) => {
      setLink(step);
      if (step.state === "done") again();
    },
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't start that. Try again.")),
  });
  const unlink = useMutation({
    mutationFn: (id: string) => homeApi.musicUnlink(home.id, box.id, id),
    onSuccess: again,
    onError: (e) => toast.error(apiErrorMessage(e, "Couldn't unlink it.")),
  });

  // While the service's page is open somewhere, ask the box now and then
  // whether it has been approved. Nothing is asked once it's done or stopped.
  const waiting = link && (link.state === "open" || link.state === "wait") ? link : null;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      homeApi
        .musicLinkGet(home.id, box.id, waiting.brand, waiting.flow)
        .then((step) => {
          setLink(step);
          if (step.state === "done") again();
        })
        .catch(() => undefined); // a missed ask is asked again
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting?.flow, home.id, box.id]);

  const cancel = () => {
    if (waiting) void homeApi.musicLinkAbort(home.id, box.id, waiting.brand, waiting.flow);
    setLink(null);
  };

  if (!box.online || !box.ready) return <p className="text-sm text-[var(--text-muted)]">The home box is offline, so music can't be checked right now.</p>;
  if (status.isLoading) return <p className="text-sm text-[var(--text-muted)]">Looking…</p>;
  if (status.isError) return <p className="text-sm text-[var(--text-muted)]">Couldn't ask the home box about music. Try again in a minute.</p>;
  const music = status.data;
  if (!music) {
    return <p className="text-sm text-[var(--text-muted)]">Playing music by name isn't set up on this home's box yet. It comes with the next Promptly update.</p>;
  }
  const speakers = home.entities.filter((e) => e.box_id === box.id && music.speakers.includes(e.id));
  const unlinked = music.brands.filter((b) => !music.sources.some((s) => s.brand === b.id));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[var(--text-muted)]">
        Link a music service and ask the assistant for music by name: "play Miles Davis in the lounge".
      </p>
      {music.sources.length > 0 && (
        <ul className="flex flex-col divide-y divide-[var(--border)]">
          {music.sources.map((s) => (
            <li key={s.id} className="flex min-h-11 items-center gap-3 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[var(--text)]">{s.name}</span>
                <span className="block text-xs text-[var(--text-muted)]">Linked</span>
              </span>
              {owner && (
                <button
                  type="button"
                  className={btn}
                  disabled={unlink.isPending}
                  onClick={() => {
                    if (window.confirm(`Unlink ${s.name}? The assistant won't be able to play from it until it's linked again.`)) unlink.mutate(s.id);
                  }}
                >
                  Unlink
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {link?.state === "done" && <p role="status" className="text-sm text-[var(--success)]">{link.name} is linked.</p>}
      {link?.state === "stopped" && <p role="alert" className="text-sm text-[var(--danger)]">{link.text}</p>}

      {waiting?.state === "open" && (
        <div role="group" aria-label={`Link ${waiting.name}`} className="rounded-xl border border-[var(--border)] p-3">
          <p className="text-sm font-medium text-[var(--text)]">Finish on {waiting.name}'s own site</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Open {waiting.site}, sign in to {waiting.name} there and approve. Your password is typed on {waiting.name}'s site only: Promptly never sees it.
          </p>
          {waiting.code && (
            <>
              <p className="mt-3 text-xs text-[var(--text-muted)]">If it asks for a code, or you'd rather use your phone, go to {waiting.site} and type:</p>
              <code className="mt-1 block select-all rounded-lg bg-[var(--hover)] px-3 py-2 text-center font-mono text-lg tracking-widest text-[var(--text)]">{waiting.code}</code>
            </>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <a className={strong} href={waiting.url} target="_blank" rel="noopener noreferrer">
              Open {waiting.site}
              <ExternalLink className="h-4 w-4" aria-hidden />
            </a>
            <button type="button" className={btn} onClick={cancel}>Cancel</button>
          </div>
          <p role="status" className="mt-3 text-xs text-[var(--text-muted)]">Waiting for you to approve it on {waiting.name}'s site. This updates by itself.</p>
        </div>
      )}
      {waiting?.state === "wait" && <p role="status" className="text-sm text-[var(--text-muted)]">Finishing…</p>}

      {!waiting &&
        unlinked.map((b) =>
          owner ? (
            <button key={b.id} type="button" className={cn(strong, "self-start")} disabled={start.isPending} onClick={() => start.mutate(b.id)}>
              Link {b.name}
            </button>
          ) : (
            <p key={b.id} className="text-sm text-[var(--text-muted)]">{b.name} isn't linked. The home's owner or a co-owner can link it here.</p>
          ),
        )}

      <p className="text-xs text-[var(--text-muted)]">{musicSummary(speakers.map((s) => s.name), home.entities.filter((e) => e.box_id === box.id && e.domain === "media_player").length)}</p>
    </div>
  );
}
