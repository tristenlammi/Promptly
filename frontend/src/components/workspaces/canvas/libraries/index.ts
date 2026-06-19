import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { LibraryItems } from "@excalidraw/excalidraw/types";

import type { IconSpec } from "./_helpers";
import { NETWORK_ICONS } from "./network";
import { ELECTRICAL_ICONS } from "./electrical";

/**
 * Bundled Excalidraw libraries shipped with Promptly's workspace canvas.
 *
 * The curated network + electrical icon sets are seeded into every board
 * via ``<Excalidraw initialData={{ libraryItems }}>`` so users have useful
 * stencils out of the box — no external library browser or CDN needed
 * (that's a later phase). Each icon is authored as a compact skeleton
 * (see ``./network`` / ``./electrical``) and expanded here into real
 * elements; every element in an icon shares a group id so it drops onto
 * the board as a single unit.
 */

// Fixed epoch so the generated library is byte-stable across reloads
// (no churn from a live timestamp).
const CREATED = 1_700_000_000_000;

let cached: LibraryItems | null = null;

export function buildBundledLibraryItems(): LibraryItems {
  if (cached) return cached;
  const specs: IconSpec[] = [...NETWORK_ICONS, ...ELECTRICAL_ICONS];
  try {
    cached = specs.map((spec) => {
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
    }) as LibraryItems;
  } catch {
    // A malformed icon must never take the whole canvas down — ship an
    // empty library rather than throwing during render.
    cached = [];
  }
  return cached;
}
