import { getTextFromElements } from "@excalidraw/excalidraw";

import { parseWikiHref } from "@/components/files/documents/WikiLinkExtension";

/**
 * Flatten an Excalidraw scene into a STRUCTURED text description so workspace
 * chats understand the board — not just its stray words, but its shape labels,
 * its connections, and which nodes are linked workspace items (A3 "OCR").
 *
 * This is exact, not fuzzy: Excalidraw stores structured elements (text,
 * shapes, arrow bindings), so we can read labels + the connection graph
 * directly. Raster images are noted as placeholders (server-side captioning
 * is a separate step); freehand strokes carry no text and are ignored.
 *
 * The result feeds ``POST /api/canvas/{id}/text`` → ``knowledge_chunks`` →
 * workspace RAG, replacing the old flat ``getTextFromElements`` bag-of-words.
 */

// Excalidraw's element type is large + branded; we only touch a handful of
// fields, so a permissive structural type keeps this readable.
interface SceneEl {
  id: string;
  type: string;
  isDeleted?: boolean;
  text?: string;
  containerId?: string | null;
  link?: string | null;
  boundElements?: { id: string; type: string }[] | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
}

const LABELLED_SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const CONNECTORS = new Set(["arrow", "line"]);

export function canvasSceneToText(elements: readonly unknown[]): string {
  const live = (elements as SceneEl[]).filter((e) => e && !e.isDeleted);
  const byId = new Map<string, SceneEl>(live.map((e) => [e.id, e]));

  // A shape's readable label = its bound text element's text.
  const labelOf = (el: SceneEl | undefined): string => {
    if (!el) return "";
    if (el.type === "text") return (el.text || "").trim();
    const boundTextId = (el.boundElements || []).find(
      (b) => b?.type === "text"
    )?.id;
    const t = boundTextId ? byId.get(boundTextId) : undefined;
    return (t?.text || "").trim();
  };

  const nodeLines: string[] = [];
  const noteLines: string[] = [];
  const edgeLines: string[] = [];
  let imageCount = 0;

  for (const el of live) {
    if (el.type === "text") {
      // Standalone text only — bound labels are emitted with their shape.
      if (el.containerId) continue;
      const t = (el.text || "").trim();
      if (t) noteLines.push(t);
      continue;
    }
    if (LABELLED_SHAPES.has(el.type)) {
      const label = labelOf(el);
      if (!label) continue;
      const linked = parseWikiHref(el.link)
        ? " [linked workspace item]"
        : "";
      nodeLines.push(`${label}${linked}`);
      continue;
    }
    if (el.type === "image") imageCount += 1;
  }

  for (const el of live) {
    if (!CONNECTORS.has(el.type)) continue;
    const a = el.startBinding
      ? labelOf(byId.get(el.startBinding.elementId))
      : "";
    const b = el.endBinding ? labelOf(byId.get(el.endBinding.elementId)) : "";
    if (!a || !b) continue;
    const via = labelOf(el);
    edgeLines.push(`${a} → ${b}${via ? ` (${via})` : ""}`);
  }

  const sections: string[] = [];
  if (nodeLines.length) sections.push(`Nodes:\n- ${nodeLines.join("\n- ")}`);
  if (edgeLines.length)
    sections.push(`Connections:\n- ${edgeLines.join("\n- ")}`);
  if (noteLines.length) sections.push(`Notes:\n- ${noteLines.join("\n- ")}`);
  if (imageCount)
    sections.push(`Images: ${imageCount} image${imageCount === 1 ? "" : "s"}`);

  const structured = sections.join("\n\n").trim();
  // Fall back to the flat text if we somehow extracted nothing structured
  // (e.g. a board of only freehand strokes) so we never regress the old
  // behaviour.
  return (
    structured ||
    getTextFromElements(elements as Parameters<typeof getTextFromElements>[0], "\n").trim()
  );
}
