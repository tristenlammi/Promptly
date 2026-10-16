/**
 * Normalise API error payloads into a human-readable string.
 *
 * FastAPI's ``detail`` is a string for ``HTTPException``s — but for
 * request-validation failures (422) it's an **array of Pydantic error
 * objects** (``{type, loc, msg, input, ctx}``), and a handful of
 * endpoints return bare objects. Rendering those straight into JSX
 * crashes React ("Objects are not valid as a React child", minified
 * error #31) — which is exactly what took down the setup wizard when
 * the backend rejected a field. Every error surface should go through
 * this helper instead of trusting ``detail`` to be a string.
 */

interface PydanticErrorItem {
  msg?: unknown;
  loc?: unknown;
}

/** Turn one Pydantic validation item into "field: message". */
function itemToMessage(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return null;
  const { msg, loc } = item as PydanticErrorItem;
  const message = typeof msg === "string" ? msg : null;
  if (!message) return null;
  // loc is like ["body", "password"] — the tail is the field name;
  // drop the "body"/"query" prefix, it means nothing to users.
  if (Array.isArray(loc)) {
    const field = loc.filter((p) => typeof p === "string" && p !== "body" && p !== "query").pop();
    if (typeof field === "string" && field) return `${field}: ${message}`;
  }
  return message;
}

/**
 * Normalise any ``detail`` payload (string | Pydantic array | object)
 * to a display string, or ``null`` when there's nothing usable.
 */
export function normalizeApiDetail(detail: unknown): string | null {
  if (typeof detail === "string") return detail.trim() || null;
  if (Array.isArray(detail)) {
    const msgs = detail.map(itemToMessage).filter(Boolean) as string[];
    if (msgs.length === 0) return null;
    // Two issues is plenty for one toast; note the rest.
    const shown = msgs.slice(0, 2).join(" · ");
    return msgs.length > 2 ? `${shown} (+${msgs.length - 2} more)` : shown;
  }
  if (detail && typeof detail === "object") return itemToMessage(detail);
  return null;
}

/**
 * Extract a safe, human-readable message from any thrown error —
 * Axios errors (via ``response.data.detail``), plain ``Error``s, or
 * anything else. Always returns a string, so the result can be put
 * straight into React state / JSX.
 */
/** What a bare HTTP status means to a person — for errors that arrive
 *  without a message of their own (often from the proxy in front of
 *  Promptly), which used to read "Request failed with status code 429". */
const STATUS_MESSAGES: Record<number, string> = {
  401: "Your session has ended. Sign in again.",
  403: "You don't have permission to do that.",
  404: "That isn't there any more — it may have been deleted.",
  408: "That took too long. Try again.",
  409: "Something changed in the meantime. Refresh and try again.",
  413: "That's too large to upload.",
  429: "Too many requests at once. Wait a moment and try again.",
  500: "Something went wrong on the server. Try again.",
  502: "Promptly is restarting or unreachable. Try again in a moment.",
  503: "Promptly is restarting or unreachable. Try again in a moment.",
  504: "The server took too long to answer. Try again.",
};

export function apiErrorMessage(err: unknown, fallback = "Something went wrong. Try again."): string {
  if (err && typeof err === "object") {
    const resp = (err as { response?: { status?: number; data?: { detail?: unknown } } }).response;
    const fromDetail = normalizeApiDetail(resp?.data?.detail);
    if (fromDetail) return fromDetail;
    if (resp?.status && STATUS_MESSAGES[resp.status]) return STATUS_MESSAGES[resp.status];
    const code = (err as { code?: string }).code;
    if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
      return "That took too long — check your connection and try again.";
    }
    if (!resp && code === "ERR_NETWORK") {
      return "Can't reach Promptly — check your connection and try again.";
    }
    if (!resp && err instanceof Error && err.message) return err.message;
  }
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}
