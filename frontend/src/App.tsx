import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AccountSecurityPage } from "@/pages/AccountSecurityPage";
import { AdminPage } from "@/pages/AdminPage";
import { AppLayout } from "@/components/layout/AppLayout";
import { ChatPage } from "@/pages/ChatPage";
import { ComparePage } from "@/pages/ComparePage";
import { CompareArchivePage } from "@/pages/CompareArchivePage";
import { FilesPage } from "@/pages/FilesPage";
import { LoginPage } from "@/pages/LoginPage";
import { MfaEnrollPage } from "@/pages/MfaEnrollPage";
import { MfaVerifyPage } from "@/pages/MfaVerifyPage";
import { ProjectDetailPage } from "@/pages/ProjectDetailPage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { SetupPage } from "@/pages/SetupPage";
import { StudyDesktopOnly } from "@/components/study/StudyDesktopOnly";
import { StudyPage } from "@/pages/StudyPage";
import { StudySessionPage } from "@/pages/StudySessionPage";
import { StudyTopicPage } from "@/pages/StudyTopicPage";
import { useAuthBootstrap } from "@/hooks/useAuthBootstrap";
import { useAuthStore } from "@/store/authStore";
import { applyTheme } from "@/store/themeStore";

export default function App() {
  useAuthBootstrap();
  const status = useAuthStore((s) => s.status);
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  // Keep the html.dark class in sync with the persisted theme on mount.
  useEffect(() => {
    applyTheme();
  }, []);

  if (status === "idle" || status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg)] text-sm text-[var(--text-muted)]">
        Loading Promptly...
      </div>
    );
  }

  if (status === "needs_setup") {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (status === "unauthenticated") {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // Mid-login MFA challenge — user proved their password but we're
  // still waiting on the second factor. Lock them onto /mfa/verify.
  if (status === "mfa_required") {
    return (
      <Routes>
        <Route path="/mfa/verify" element={<MfaVerifyPage />} />
        <Route path="*" element={<Navigate to="/mfa/verify" replace />} />
      </Routes>
    );
  }

  // Forced enrollment — admin turned on ``mfa_required`` and this
  // user has no method yet. Lock them onto /mfa/enroll until they
  // finish the wizard.
  if (status === "mfa_enrollment_required") {
    return (
      <Routes>
        <Route path="/mfa/enroll" element={<MfaEnrollPage />} />
        <Route path="*" element={<Navigate to="/mfa/enroll" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/chat" replace />} />
      <Route path="/setup" element={<Navigate to="/chat" replace />} />
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/new" element={<Navigate to="/chat" replace />} />
        {/* Compare routes live under /chat/compare so they slot into
            the chat sidebar's "section" hierarchy without needing a
            new top-level nav item. The bare ``/chat/compare`` entry
            redirects to the archive so a click on the sidebar entry
            always lands on a useful listing. */}
        <Route
          path="/chat/compare"
          element={<Navigate to="/chat/compare/archive" replace />}
        />
        <Route path="/chat/compare/archive" element={<CompareArchivePage />} />
        <Route path="/chat/compare/new" element={<ComparePage />} />
        <Route path="/chat/compare/:id" element={<ComparePage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route
          path="/study"
          element={
            <StudyDesktopOnly>
              <StudyPage />
            </StudyDesktopOnly>
          }
        />
        <Route
          path="/study/topics/:id"
          element={
            <StudyDesktopOnly>
              <StudyTopicPage />
            </StudyDesktopOnly>
          }
        />
        <Route
          path="/study/sessions/:id"
          element={
            <StudyDesktopOnly>
              <StudySessionPage />
            </StudyDesktopOnly>
          }
        />
        {/* Models management lives inside the Settings (admin) tabs
            now. Keep the legacy ``/models`` URL working by redirecting
            straight to the relevant tab so old bookmarks don't 404. */}
        <Route
          path="/models"
          element={
            isAdmin ? (
              <Navigate to="/admin?tab=models" replace />
            ) : (
              <Navigate to="/chat" replace />
            )
          }
        />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/account/security" element={<AccountSecurityPage />} />
        <Route
          path="/admin"
          element={isAdmin ? <AdminPage /> : <Navigate to="/chat" replace />}
        />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Route>
    </Routes>
  );
}
