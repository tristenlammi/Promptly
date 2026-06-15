import type { TLAnyShapeUtilConstructor } from "tldraw";

import { ItemCardShapeUtil } from "./ItemCardShape";

/**
 * The workspace canvas's custom shape utils. This single array MUST be
 * registered in two places that have to agree:
 *
 *  1. ``createTLStore`` (in ``useYjsCanvasStore``) — so a custom record
 *     arriving from a remote peer can be deserialized/validated.
 *  2. ``<Tldraw shapeUtils={...}>`` (in ``WorkspaceCanvasPane``) — so the
 *     editor knows how to render + interact with it.
 *
 * Keeping them in one exported constant prevents the two from drifting.
 */
export const customShapeUtils: TLAnyShapeUtilConstructor[] = [ItemCardShapeUtil];
