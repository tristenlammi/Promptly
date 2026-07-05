import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AccountSecurityPage } from "@/pages/AccountSecurityPage";
import { AdminPage } from "@/pages/AdminPage";
import { AppLayout } from "@/components/layout/AppLayout";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { ConfirmHost } from "@/components/shared/ConfirmDialog";
import { ChatPage } from "@/pages/ChatPage";
import { FilesPage, SharedWithMePage } from "@/pages/FilesPage";
import { LoginPage } from "@/pages/LoginPage";
import { MfaEnrollPage } from "@/pages/MfaEnrollPage";
import { MfaVerifyPage } from "@/pages/MfaVerifyPage";
import { WorkspaceDetailPage } from "@/pages/WorkspaceDetailPage";
import { WorkspacesPage } from "@/pages/WorkspacesPage";
import { RecentFilesPage } from "@/pages/RecentFilesPage";
import { SearchResultsPage } from "@/pages/SearchResultsPage";
import { SetupPage } from "@/pages/SetupPage";
import { ShareLinkLandingPage } from "@/pages/ShareLinkLandingPage";
import { StarredFilesPage } from "@/pages/StarredFilesPage";
import { StudyDesktopOnly } from "@/components/study/StudyDesktopOnly";
import { StudyPage } from "@/pages/StudyPage";
import { ReviewPage } from "@/pages/ReviewPage";
import { StudySessionPage } from "@/pages/StudySessionPage";
import { StudyTopicPage } from "@/pages/StudyTopicPage";
import { ArchivePage } from "@/pages/ArchivePage";
import { TaskDetailPage } from "@/pages/TaskDetailPage";
import { TasksPage } from "@/pages/TasksPage";
import { MyWorkPage } from "@/pages/MyWorkPage";
import { TrashPage } from "@/pages/TrashPage";
import { useAuthBootstrap } from "@/hooks/useAuthBootstrap";
import { useDrivePwaManifest } from "@/hooks/useDrivePwaManifest";
import { useAuthStore } from "@/store/authStore";
import { useModelStore } from "@/store/modelStore";
import { applyTheme } from "@/store/themeStore";

export default function App() {
  useAuthBootstrap();
  // Swap the active web manifest on /files* so the browser install
  // prompt targets the standalone "Promptly Files" PWA identity,
  // keeping the main Promptly (chat) install separate.
  useDrivePwaManifest();
  const status = useAuthStore((s) => s.status);
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  // The admin reaches the admin surface.
  const canManageOrg = useAuthStore((s) => s.user?.role === "admin");

  // Keep the model store's "default model" mirror in sync with
  // ``user.settings`` so every new chat starts on the user's preferred
  // model. The settings sub-object is recreated whenever the user
  // changes (login, /me refresh, preferences PATCH), which flips the
  // selector and re-runs this effect — at which point we push the
  // pair into the model store's ``setDefault``.
  const userSettings = useAuthStore((s) => s.user?.settings);
  useEffect(() => {
    const provider =
      typeof userSettings?.default_provider_id === "string"
        ? userSettings.default_provider_id
        : null;
    const model =
      typeof userSettings?.default_model_id === "string"
        ? userSettings.default_model_id
        : null;
    useModelStore.getState().setDefault(provider, model);
  }, [userSettings]);

  // Also mirror the admin-configured workspace defaults — the default
  // chat model (used as a picker fallback) and the vision relay
  // (used by the composer to soften the "model can't read images"
  // warning when a relay is configured). Fetched once on login (any-
  // role endpoint); failures are swallowed because a non-fatal config
  // read shouldn't gate the chat UI from loading.
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    (async () => {
      try {
        const { workspaceDefaultsApi } = await import(
          "@/api/workspaceDefaults"
        );
        const data = await workspaceDefaultsApi.get();
        if (cancelled) return;
        const store = useModelStore.getState();
        store.setAdminDefault(
          data.default_chat_provider_id ?? null,
          data.default_chat_model_id ?? null,
        );
        store.setVisionRelay(
          data.vision_relay_provider_id ?? null,
          data.vision_relay_model_id ?? null,
        );
      } catch {
        // No retry — the workspace defaults are a nice-to-have, not
        // load-bearing. The fallback chain still has "first available"
        // beneath it, and the composer's vision warning still works
        // (it just doesn't know about the relay).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  // Keep the html.dark class in sync with the persisted theme on mount.
  useEffect(() => {
    applyTheme();
  }, []);

  // Runtime companion to the manifest's ``orientation: portrait``.
  //
  // Installed PWAs pick up the manifest declaration automatically,
  // but plain browser tabs need an explicit call to the Screen
  // Orientation API. On supporting browsers (Chrome/Edge Android in
  // fullscreen or installed-PWA context) this pins the layout to
  // portrait; on browsers that reject the lock outside fullscreen
  // (most mobile Safari) the call throws and we swallow silently —
  // the manifest still covers the home-screen install path, and a
  // non-installed Safari tab can't be locked from JS anyway.
  useEffect(() => {
    // ``ScreenOrientation.lock`` is defined in the WICG Screen
    // Orientation spec but not yet in lib.dom — we narrow through a
    // minimal structural type so TS doesn't complain.
    type LockableOrientation = ScreenOrientation & {
      lock?: (orientation: "portrait") => Promise<void>;
    };
    const orientation = screen.orientation as LockableOrientation | undefined;
    if (!orientation || typeof orientation.lock !== "function") return;
    try {
      const p = orientation.lock("portrait");
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          /* browser refused (e.g. Safari outside fullscreen) — no-op */
        });
      }
    } catch {
      /* older browsers throw synchronously — no-op */
    }
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
        {/* The landing page itself enforces any password / sign-in
            requirements via the backend, so we let the route
            through without the global redirect-to-login. */}
        <Route path="/s/:token" element={<ShareLinkLandingPage />} />
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

  const authedApp = (
    <Routes>
      <Route path="/login" element={<Navigate to="/chat" replace />} />
      <Route path="/setup" element={<Navigate to="/chat" replace />} />
      {/* Share-link landing page lives OUTSIDE AppLayout so it has
          no chat sidebar, no auth chrome, and no Promptly-branded
          nav — just the shared file/folder. Mounted above the
          AppLayout block so it wins the route match. */}
      <Route path="/s/:token" element={<ShareLinkLandingPage />} />
      <Route element={<AppLayout />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/new" element={<Navigate to="/chat" replace />} />
        {/* Compare mode was decommissioned (Phase 1 cleanup). Any stale
            bookmark to the old /chat/compare* routes falls through to the
            catch-all and redirects to /chat. */}
        <Route path="/chat/:id" element={<ChatPage />} />
        <Route path="/workspaces" element={<WorkspacesPage />} />
        <Route path="/workspaces/:id" element={<WorkspaceDetailPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
        <Route path="/work" element={<MyWorkPage />} />
        {/* Study home + topic detail are fully mobile-friendly. */}
        <Route path="/study" element={<StudyPage />} />
        <Route path="/study/topics/:id" element={<StudyTopicPage />} />
        {/* Review page: mobile-first by design (daily habit use case). */}
        <Route path="/study/topics/:id/review" element={<ReviewPage />} />
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
        {/* Drive surfaces. Every one has its own deep-linkable URL
            — prereq for the stage-3 "Promptly Drive" PWA split. */}
        <Route path="/files" element={<FilesPage />} />
        <Route path="/files/folder/:folderId" element={<FilesPage />} />
        <Route path="/files/recent" element={<RecentFilesPage />} />
        <Route path="/files/starred" element={<StarredFilesPage />} />
        <Route path="/files/shared" element={<SharedWithMePage />} />
        <Route path="/files/trash" element={<TrashPage />} />
        <Route path="/files/search" element={<SearchResultsPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/account/security" element={<AccountSecurityPage />} />
        <Route
          path="/admin"
          element={
            canManageOrg ? <AdminPage /> : <Navigate to="/chat" replace />
          }
        />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Route>
    </Routes>
  );

  return (
    <>
      {authedApp}
      <ToastViewport />
      <ConfirmHost />
    </>
  );
}
