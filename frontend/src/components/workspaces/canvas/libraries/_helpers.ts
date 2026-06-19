import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";

/**
 * Authoring helpers for the bundled Excalidraw icon libraries.
 *
 * Each icon is a small array of *skeletons* — compact shape descriptions
 * that ``convertToExcalidrawElements`` (see ``./index``) expands into real
 * Excalidraw elements at load time. Authoring skeletons (vs. full element
 * JSON) keeps the libraries readable and lets Excalidraw fill in the
 * dozens of required element fields for us.
 *
 * The ``as Skeleton`` casts paper over Excalidraw's branded point/typing
 * (e.g. ``LocalPoint``); our hand-authored coordinates are plain arrays
 * and behave correctly at runtime.
 */
export type Skeleton = ExcalidrawElementSkeleton;

export interface IconSpec {
  /** Stable, unique id — keeps the library item identical across reloads
   *  so re-seeding never duplicates it. */
  id: string;
  name: string;
  skeleton: Skeleton[];
}

const DEFAULT_STROKE = "#1e1e1e";

/** A labelled container (rectangle / ellipse / diamond). The label is
 *  auto-centered and bound to the shape by ``convertToExcalidrawElements``. */
export function box(
  type: "rectangle" | "ellipse" | "diamond",
  width: number,
  height: number,
  label: string,
  strokeColor: string = DEFAULT_STROKE
): Skeleton {
  return {
    type,
    x: 0,
    y: 0,
    width,
    height,
    strokeColor,
    label: { text: label, fontSize: 16 },
  } as Skeleton;
}

/** A multi-segment line. ``points`` are relative to ``(x, y)``. */
export function line(
  x: number,
  y: number,
  points: [number, number][],
  strokeColor: string = DEFAULT_STROKE
): Skeleton {
  return { type: "line", x, y, points, strokeColor } as Skeleton;
}

/** A bare ellipse (no label). */
export function ellipse(
  x: number,
  y: number,
  width: number,
  height: number,
  strokeColor: string = DEFAULT_STROKE
): Skeleton {
  return { type: "ellipse", x, y, width, height, strokeColor } as Skeleton;
}

/** A standalone text label. */
export function text(
  x: number,
  y: number,
  value: string,
  fontSize = 16
): Skeleton {
  return { type: "text", x, y, text: value, fontSize } as Skeleton;
}
