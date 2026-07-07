import type { IconSpec, Skeleton } from "./_helpers";

/**
 * Promptly's own canvas presets — the building blocks of the marketing
 * mockup, seeded into every board's library so a clean structured board is a
 * drag away. Authored with ``roughness: 0`` (architect stroke) and the app
 * palette so they read as "our canvas", not generic Excalidraw.
 */

const TERRACOTTA = "#d97757";
const STICKY_INK = "#3d3320";

/** A clean terracotta node: rounded rectangle, architect stroke, centred
 *  label. The mockup's "Idea backlog" / "Q3 launch scope" boxes. */
function node(label: string): Skeleton {
  return {
    type: "rectangle",
    x: 0,
    y: 0,
    width: 160,
    height: 64,
    strokeColor: TERRACOTTA,
    backgroundColor: "transparent",
    strokeWidth: 2,
    roughness: 0,
    roundness: { type: 3 },
    label: { text: label, fontSize: 16, strokeColor: TERRACOTTA },
  } as Skeleton;
}

/** A pastel sticky note: solid fill, borderless (stroke = fill), warm ink.
 *  Excalidraw can't do the mockup's drop-shadow, but the fill + ink read as
 *  a sticky. */
function sticky(bg: string, label: string): Skeleton {
  return {
    type: "rectangle",
    x: 0,
    y: 0,
    width: 150,
    height: 104,
    strokeColor: bg,
    backgroundColor: bg,
    fillStyle: "solid",
    strokeWidth: 1,
    roughness: 0,
    label: { text: label, fontSize: 14, strokeColor: STICKY_INK },
  } as Skeleton;
}

export const PROMPTLY_PRESETS: IconSpec[] = [
  { id: "promptly-node", name: "Node", skeleton: [node("Node")] },
  {
    id: "promptly-sticky-yellow",
    name: "Sticky note (yellow)",
    skeleton: [sticky("#FDE68A", "Note")],
  },
  {
    id: "promptly-sticky-green",
    name: "Sticky note (green)",
    skeleton: [sticky("#BBF7D0", "Note")],
  },
  {
    id: "promptly-sticky-pink",
    name: "Sticky note (pink)",
    skeleton: [sticky("#FBCFE8", "Note")],
  },
];
