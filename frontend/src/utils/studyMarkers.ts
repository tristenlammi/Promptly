/**
 * Marker tokens the Study tutor emits inside its replies to request a
 * specific inline UI affordance.
 *
 * - ``<request_confidence/>`` — shows the 1-5 confidence slider next
 *   to that message so the student can click instead of typing a
 *   number. Fires ``POST /sessions/{id}/confidence`` when submitted.
 * - ``<request_teachback/>`` — shows the "your turn to explain it
 *   back" banner so the student knows the next reply should be in
 *   their own words.
 *
 * Markers are stripped from rendered content before the message body
 * hits the markdown pipeline — students should never see the raw
 * tokens even if the model misformats them.
 *
 * Also tolerant of whitespace and the self-closing / open-tag variants
 * (``<request_confidence>`` without the slash) so a model that drifts
 * from the exact template isn't penalised.
 */

const CONFIDENCE_MARKER_RE = /<\s*request_confidence\s*\/?\s*>/gi;
const TEACHBACK_MARKER_RE = /<\s*request_teachback\s*\/?\s*>/gi;

export interface StudyMarkers {
  stripped: string;
  requestConfidence: boolean;
  requestTeachback: boolean;
}

export function extractStudyMarkers(content: string): StudyMarkers {
  const requestConfidence = CONFIDENCE_MARKER_RE.test(content);
  const requestTeachback = TEACHBACK_MARKER_RE.test(content);
  CONFIDENCE_MARKER_RE.lastIndex = 0;
  TEACHBACK_MARKER_RE.lastIndex = 0;

  if (!requestConfidence && !requestTeachback) {
    return { stripped: content, requestConfidence: false, requestTeachback: false };
  }

  const stripped = content
    .replace(CONFIDENCE_MARKER_RE, "")
    .replace(TEACHBACK_MARKER_RE, "")
    // Collapse any stray double-blank-line artefact left behind by the
    // marker removal so the visible text keeps its natural rhythm.
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { stripped, requestConfidence, requestTeachback };
}
