import { apiClient } from "@/api/client";

/**
 * Document images and audio (WP-4.6, R-228). A document stores an asset's
 * *path* (``/api/documents/{doc}/assets/{asset}``); to show it we ask the
 * backend for a short-lived signed link (``POST /api/documents/asset-links``,
 * authorised by read access to the document). Requests made in the same
 * tick are batched; links are cached until shortly before they expire.
 *
 * Old content carries a permanent ``?sig=`` — its path is what matters,
 * so it's re-signed the same way (and keeps working if the server key
 * ever changes).
 */
const ASSET_RE = /\/api\/documents\/[0-9a-fA-F-]{36}\/assets\/[0-9a-fA-F-]{36}(?:\?[^"'\s<>)]*)?/g;
const ONE_ASSET = /^\/api\/documents\/[0-9a-fA-F-]{36}\/assets\/[0-9a-fA-F-]{36}(?:\?.*)?$/;

/** The asset path, without any query string. */
export function assetPath(src: string): string {
  return src.split("?")[0];
}

export function isAssetUrl(src: string | null | undefined): boolean {
  return !!src && ONE_ASSET.test(src);
}

const cache = new Map<string, { url: string; until: number }>();
let queue: Map<string, { resolve: (u: string) => void; reject: (e: unknown) => void }[]> | null = null;

function expiryOf(url: string): number {
  const exp = Number(new URL(url, window.location.origin).searchParams.get("exp"));
  // Re-ask ten minutes before it lapses; a legacy link (no exp) for an hour.
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 - 10 * 60_000 : Date.now() + 3_600_000;
}

async function flush(batch: NonNullable<typeof queue>): Promise<void> {
  const paths = [...batch.keys()];
  for (let i = 0; i < paths.length; i += 300) {
    const chunk = paths.slice(i, i + 300);
    try {
      const { data } = await apiClient.post<{ links: Record<string, string> }>("/documents/asset-links", { urls: chunk });
      for (const path of chunk) {
        const url = data.links[path];
        const waiters = batch.get(path) ?? [];
        if (url) {
          cache.set(path, { url, until: expiryOf(url) });
          waiters.forEach((w) => w.resolve(url));
        } else {
          waiters.forEach((w) => w.reject(new Error("asset unavailable")));
        }
      }
    } catch (e) {
      for (const path of chunk) (batch.get(path) ?? []).forEach((w) => w.reject(e));
    }
  }
}

/** A displayable, signed URL for a document asset (anything else is
 *  returned as it is). Rejects when the asset is gone or not yours to see. */
export function resolveAssetUrl(src: string): Promise<string> {
  if (!isAssetUrl(src)) return Promise.resolve(src);
  const path = assetPath(src);
  const hit = cache.get(path);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.url);
  return new Promise((resolve, reject) => {
    if (!queue) {
      queue = new Map();
      const batch = queue;
      queueMicrotask(() => {
        queue = null;
        void flush(batch);
      });
    }
    const waiters = queue.get(path) ?? [];
    waiters.push({ resolve, reject });
    queue.set(path, waiters);
  });
}

/** ``html`` with every document-asset link swapped for a signed one (for
 *  previews that render stored HTML). Unresolvable links are left as-is. */
export async function resolveAssetsInHtml(html: string): Promise<string> {
  const found = [...new Set(html.match(ASSET_RE) ?? [])];
  if (!found.length) return html;
  const resolved = new Map<string, string>();
  await Promise.all(
    found.map((src) =>
      resolveAssetUrl(src.replace(/&amp;/g, "&")).then(
        (u) => void resolved.set(src, u),
        () => undefined
      )
    )
  );
  return html.replace(ASSET_RE, (m) => (resolved.has(m) ? resolved.get(m)!.replace(/&/g, "&amp;") : m));
}

/** Drop any query from asset links (a restore or paste shouldn't bake a
 *  link — signed or not — into the document; the path is enough). */
export function normalizeAssetUrls(html: string): string {
  return html.replace(ASSET_RE, (m) => assetPath(m));
}
