import { Route, Routes } from "react-router-dom";

import { ContinuePage, ReviewStartPage } from "./pages/GoPages";
import { HomePage } from "./pages/HomePage";
import { LessonPage } from "./pages/LessonPage";
import { NewSubjectPage } from "./pages/NewSubjectPage";
import { ReportPage } from "./pages/ReportPage";
import { SubjectPage } from "./pages/SubjectPage";

/**
 * Study (``/study``): an AI teacher for any subject. A built-in app with
 * its own tables (``backend/app/study``); contract in ``docs/study-api.md``.
 *
 *   /study                          your subjects
 *   /study/new                      new subject
 *   /study/:subjectId               being built → placement offer → the map
 *   /study/:subjectId/learn/:sessionId   the lesson player (and the placement check)
 *   /study/:subjectId/continue      start or pick up the next lesson (notifications open this)
 *   /study/:subjectId/report        the report: what you know, what is shaky, what's next
 *   /study/review                   start a review of everything that is due
 *   /study/review/:sessionId        the player, on a review across subjects
 *   /study/:subjectId/review        start a review of one subject
 */
export function StudyApp() {
  return (
    <Routes>
      <Route index element={<HomePage />} />
      <Route path="new" element={<NewSubjectPage />} />
      <Route path="review" element={<ReviewStartPage />} />
      <Route path="review/:sessionId" element={<LessonPage />} />
      <Route path=":subjectId" element={<SubjectPage />} />
      <Route path=":subjectId/learn/:sessionId" element={<LessonPage />} />
      <Route path=":subjectId/continue" element={<ContinuePage />} />
      <Route path=":subjectId/review" element={<ReviewStartPage />} />
      <Route path=":subjectId/report" element={<ReportPage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}
