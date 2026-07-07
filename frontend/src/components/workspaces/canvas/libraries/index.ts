import {
  convertToExcalidrawElements,
  restoreLibraryItems,
} from "@excalidraw/excalidraw";
import type { LibraryItems } from "@excalidraw/excalidraw/types";

import type { IconSpec } from "./_helpers";
import { PROMPTLY_PRESETS } from "./presets";
import { NETWORK_ICONS } from "./network";
import { ELECTRICAL_ICONS } from "./electrical";

type LibraryItem = LibraryItems[number];

/**
 * Bundled Excalidraw libraries shipped with Promptly's workspace canvas,
 * seeded into every board via ``<Excalidraw initialData={{ libraryItems }}>``.
 *
 * Two sources, merged:
 *  1. Hand-authored icon sets (network / electrical) built from compact
 *     skeletons — see ``./network`` / ``./electrical``.
 *  2. **Drop-in packs**: any ``*.excalidrawlib`` file placed in ``./packs/``
 *     is auto-bundled at build time (no code changes). Download a library
 *     from https://libraries.excalidraw.com (or export your own), drop the
 *     file in that folder, rebuild — done. Both the v1 (``library``) and v2
 *     (``libraryItems``) file formats are handled via ``restoreLibraryItems``.
 */

// Fixed epoch so the generated library is byte-stable across reloads.
const CREATED = 1_700_000_000_000;

// Vite inlines every matching pack as a raw JSON string at build time.
const PACK_FILES = import.meta.glob("./packs/*.excalidrawlib", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

let cached: LibraryItems | null = null;

function buildIconLibrary(specs: IconSpec[]): LibraryItem[] {
  return specs.map((spec) => {
    const groupId = `${spec.id}-group`;
    const elements = convertToExcalidrawElements(spec.skeleton).map((el) => ({
      ...el,
      groupIds: [groupId],
    }));
    return {
      id: spec.id,
      status: "unpublished" as const,
      elements,
      created: CREATED,
      name: spec.name,
    };
  }) as LibraryItem[];
}

function loadDropInPacks(): LibraryItem[] {
  const items: LibraryItem[] = [];
  for (const [path, raw] of Object.entries(PACK_FILES)) {
    try {
      const parsed = JSON.parse(raw) as {
        libraryItems?: unknown;
        library?: unknown;
      };
      const restored = restoreLibraryItems(
        (parsed.libraryItems ??
          parsed.library) as Parameters<typeof restoreLibraryItems>[0],
        "unpublished"
      );
      items.push(...restored);
    } catch {
      // A malformed pack must never break the whole library.
      // eslint-disable-next-line no-console
      console.warn(`[canvas] skipped malformed library pack: ${path}`);
    }
  }
  return items;
}

export function buildBundledLibraryItems(): LibraryItems {
  if (cached) return cached;
  try {
    cached = [
      // Promptly's own node + sticky presets first, so they're the top of
      // the library panel.
      ...buildIconLibrary([
        ...PROMPTLY_PRESETS,
        ...NETWORK_ICONS,
        ...ELECTRICAL_ICONS,
      ]),
      ...loadDropInPacks(),
    ];
  } catch {
    // Ship an empty library rather than throwing during render.
    cached = [];
  }
  return cached;
}
