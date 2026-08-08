import { Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppLayout } from "@/components/layout/AppLayout";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { ConfirmHost } from "@/components/shared/ConfirmDialog";
import { ChatPage } from "@/pages/ChatPage";
import { LoginPage } from "@/pages/LoginPage";
import { MfaEnrollPage } from "@/pages/MfaEnrollPage";
import { MfaVerifyPage } from "@/pages/MfaVerifyPage";
import { SetupPage } from "@/pages/SetupPage";
import { useAuthBootstrap } from "@/hooks/useAuthBootstrap";
import { useDrivePwaManifest } from "@/hooks/useDrivePwaManifest";
import { useAuthStore } from "@/store/authStore";
import { useModelStore } from "@/store/modelStore";
import { applyTheme } from "@/store/themeStore";
import { lazyWithRetry } from "@/utils/lazyWithRetry";

// Route-level code splitting. Every page used to be imported eagerly,
// so opening a chat downloaded the admin console, the automations flow
// editor and the whole Drive surface first — a 2.4 MB entry chunk to
// render a text box. These load on first navigation instead; the
// Suspense boundary lives in AppLayout so the sidebar stays put.
//
// ``lazyWithRetry`` (not bare ``React.lazy``) because a redeploy under
// an open tab invalidates the hashed chunk names a stale page points
// at; it recovers with a one-time reload instead of a blank screen.
const AccountSecurityPage = lazyWithRetry(
  () => import("@/pages/AccountSecurityPage").then((m) => ({ default: m.AccountSecurityPage })),
  "AccountSecurityPage"
);
const AdminPage = lazyWithRetry(
  () => import("@/pages/AdminPage").then((m) => ({ default: m.AdminPage })),
  "AdminPage"
);
const ArchivePage = lazyWithRetry(
  () => import("@/pages/ArchivePage").then((m) => ({ default: m.ArchivePage })),
  "ArchivePage"
);
const FilesPage = lazyWithRetry(
  () => import("@/pages/FilesPage").then((m) => ({ default: m.FilesPage })),
  "FilesPage"
);
const SharedWithMePage = lazyWithRetry(
  () => import("@/pages/FilesPage").then((m) => ({ default: m.SharedWithMePage })),
  "SharedWithMePage"
);
const MyWorkPage = lazyWithRetry(
  () => import("@/pages/MyWorkPage").then((m) => ({ default: m.MyWorkPage })),
  "MyWorkPage"
);
const RecentFilesPage = lazyWithRetry(
  () => import("@/pages/RecentFilesPage").then((m) => ({ default: m.RecentFilesPage })),
  "RecentFilesPage"
);
const SearchResultsPage = lazyWithRetry(
  () => import("@/pages/SearchResultsPage").then((m) => ({ default: m.SearchResultsPage })),
  "SearchResultsPage"
);
const ShareLinkLandingPage = lazyWithRetry(
  () => import("@/pages/ShareLinkLandingPage").then((m) => ({ default: m.ShareLinkLandingPage })),
  "ShareLinkLandingPage"
);
const StarredFilesPage = lazyWithRetry(
  () => import("@/pages/StarredFilesPage").then((m) => ({ default: m.StarredFilesPage })),
  "StarredFilesPage"
);
const TaskDetailPage = lazyWithRetry(
  () => import("@/pages/TaskDetailPage").then((m) => ({ default: m.TaskDetailPage })),
  "TaskDetailPage"
);
const TasksPage = lazyWithRetry(
  () => import("@/pages/TasksPage").then((m) => ({ default: m.TasksPage })),
  "TasksPage"
);
const TrashPage = lazyWithRetry(
  () => import("@/pages/TrashPage").then((m) => ({ default: m.TrashPage })),
  "TrashPage"
);
const WorkspaceDetailPage = lazyWithRetry(
  () => import("@/pages/WorkspaceDetailPage").then((m) => ({ default: m.WorkspaceDetailPage })),
  "WorkspaceDetailPage"
);
const WorkspacesPage = lazyWithRetry(
  () => import("@/pages/WorkspacesPage").then((m) => ({ default: m.WorkspacesPage })),
  "WorkspacesPage"
);

/** Full-screen pending state for lazy routes rendered outside AppLayout
 *  (which hosts its own boundary). Matches the auth-bootstrap screen so a
 *  cold load doesn't visibly change shape. */
function FullScreenLoading() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg)] text-sm text-[var(--text-muted)]">
      Loading Promptly...
    </div>
  );
}

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
        <Route
          path="/s/:token"
          element={
            <Suspense fallback={<FullScreenLoading />}>
              <ShareLinkLandingPage />
            </Suspense>
          }
        />
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
      <Route
          path="/s/:token"
          element={
            <Suspense fallback={<FullScreenLoading />}>
              <ShareLinkLandingPage />
            </Suspense>
          }
        />
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
