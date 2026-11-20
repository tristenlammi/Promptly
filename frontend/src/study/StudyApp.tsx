import { Route, Routes } from "react-router-dom";

import { HomePage } from "./pages/HomePage";
import { LessonPage } from "./pages/LessonPage";
import { NewSubjectPage } from "./pages/NewSubjectPage";
import { SubjectPage } from "./pages/SubjectPage";

/**
 * Study (``/study``): an AI teacher for any subject. A built-in app with
 * its own tables (``backend/app/study``); contract in ``docs/study-api.md``.
 *
 *   /study                          your subjects
 *   /study/new                      new subject
 *   /study/:subjectId               being built → placement offer → the map
 *   /study/:subjectId/learn/:sessionId   the lesson player (and the placement check)
 */
export function StudyApp() {
  return (
    <Routes>
      <Route index element={<HomePage />} />
      <Route path="new" element={<NewSubjectPage />} />
      <Route path=":subjectId" element={<SubjectPage />} />
      <Route path=":subjectId/learn/:sessionId" element={<LessonPage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}
