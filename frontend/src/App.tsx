import { Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { AppLayout } from "@/components/layout/AppLayout";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { UpdateBanner } from "@/components/layout/UpdateBanner";
import { ConfirmHost } from "@/components/shared/ConfirmDialog";
import { ChatPage } from "@/pages/ChatPage";
import { LoginPage } from "@/pages/LoginPage";
import { ForgotPasswordPage, ResetPasswordPage } from "@/pages/PasswordResetPages";
import { MfaEnrollPage } from "@/pages/MfaEnrollPage";
import { MfaVerifyPage } from "@/pages/MfaVerifyPage";
import { SetupPage, setupInProgress } from "@/pages/SetupPage";
import { ForcePasswordChangePage } from "@/pages/ForcePasswordChangePage";
import { useAuthBootstrap } from "@/hooks/useAuthBootstrap";
import { rememberReturnTo, takeReturnTo } from "@/lib/returnTo";
import { noteSignedInUser } from "@/lib/session";
import { adoptBrowserTimezone } from "@/lib/timezone";
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
const FilesShell = lazyWithRetry(
  () => import("@/components/files/FilesShell").then((m) => ({ default: m.FilesShell })),
  "FilesShell"
);
const PhotosPage = lazyWithRetry(
  () => import("@/pages/PhotosPage").then((m) => ({ default: m.PhotosPage })),
  "PhotosPage"
);
const PhotoAlbumsPage = lazyWithRetry(
  () => import("@/pages/PhotoAlbumsPage").then((m) => ({ default: m.PhotoAlbumsPage })),
  "PhotoAlbumsPage"
);
const PeoplePage = lazyWithRetry(
  () => import("@/pages/PeoplePage").then((m) => ({ default: m.PeoplePage })),
  "PeoplePage"
);
const PersonPage = lazyWithRetry(
  () => import("@/pages/PeoplePage").then((m) => ({ default: m.PersonPage })),
  "PersonPage"
);
const PhotoSearchPage = lazyWithRetry(
  () => import("@/pages/PhotoSearchPage").then((m) => ({ default: m.PhotoSearchPage })),
  "PhotoSearchPage"
);
const PhotoPlacesPage = lazyWithRetry(
  () => import("@/pages/PhotoPlacesPage").then((m) => ({ default: m.PhotoPlacesPage })),
  "PhotoPlacesPage"
);
const PhotoCleanupPage = lazyWithRetry(
  () => import("@/pages/PhotoCleanupPage").then((m) => ({ default: m.PhotoCleanupPage })),
  "PhotoCleanupPage"
);
const PhotoSetupPage = lazyWithRetry(
  () => import("@/pages/PhotoSetupPage").then((m) => ({ default: m.PhotoSetupPage })),
  "PhotoSetupPage"
);
const PhotoMapPage = lazyWithRetry(
  () => import("@/pages/PhotoMapPage").then((m) => ({ default: m.PhotoMapPage })),
  "PhotoMapPage"
);
const MemoryPage = lazyWithRetry(
  () => import("@/pages/MemoryPage").then((m) => ({ default: m.MemoryPage })),
  "MemoryPage"
);
const PhotoAlbumPage = lazyWithRetry(
  () => import("@/pages/PhotoAlbumsPage").then((m) => ({ default: m.PhotoAlbumPage })),
  "PhotoAlbumPage"
);
const ImportsPage = lazyWithRetry(
  () => import("@/pages/ImportPage").then((m) => ({ default: m.ImportsPage })),
  "ImportsPage"
);
const ImportJobPage = lazyWithRetry(
  () => import("@/pages/ImportPage").then((m) => ({ default: m.ImportJobPage })),
  "ImportJobPage"
);
const FilesHomePage = lazyWithRetry(
  () => import("@/pages/FilesHomePage").then((m) => ({ default: m.FilesHomePage })),
  "FilesHomePage"
);
const WorkspaceDrivePage = lazyWithRetry(
  () => import("@/pages/WorkspaceDrivePage").then((m) => ({ default: m.WorkspaceDrivePage })),
  "WorkspaceDrivePage"
);
const WorkspaceDrivesIndexPage = lazyWithRetry(
  () => import("@/pages/WorkspaceDrivePage").then((m) => ({ default: m.WorkspaceDrivesIndexPage })),
  "WorkspaceDrivesIndexPage"
);
const FileDeepLinkPage = lazyWithRetry(
  () => import("@/pages/FileDeepLinkPage").then((m) => ({ default: m.FileDeepLinkPage })),
  "FileDeepLinkPage"
);
const OfficeEditorPage = lazyWithRetry(
  () => import("@/pages/OfficeEditorPage").then((m) => ({ default: m.OfficeEditorPage })),
  "OfficeEditorPage"
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
const SharedLinksPage = lazyWithRetry(
  () => import("@/pages/SharedLinksPage").then((m) => ({ default: m.SharedLinksPage })),
  "SharedLinksPage"
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

/** An admin who left the setup wizard part-way (reload, closed tab) is
 *  taken back to it once, on sign-in. */
function useResumeSetup(status: string) {
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  useEffect(() => {
    if (status === "authenticated" && isAdmin && setupInProgress() && location.pathname !== "/setup") {
      navigate("/setup", { replace: true });
    }
    // Once per sign-in, not on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isAdmin]);
}

/** Send a signed-out visitor to sign in, remembering where they were going
 *  so a link to a chat or file isn't lost (R-102). */
function ToLogin() {
  const location = useLocation();
  rememberReturnTo(location.pathname + location.search + location.hash);
  return <Navigate to="/login" replace />;
}

/** After an SSO round trip (or a reload during sign-in) the app lands on
 *  its default page; take the visitor on to where they were going. */
function useReturnAfterSignIn(status: string) {
  const navigate = useNavigate();
  const location = useLocation();
  const here = location.pathname + location.search + location.hash;
  useEffect(() => {
    if (status !== "authenticated") return;
    const target = takeReturnTo(null);
    if (target && target !== here) navigate(target, { replace: true });
    // Signed in and running: a failed-chunk reload is no longer in progress.
    const t = window.setTimeout(() => {
      try {
        sessionStorage.removeItem("chunk-reload:boundary");
      } catch {
        /* ignore */
      }
    }, 10_000);
    return () => window.clearTimeout(t);
    // Only when sign-in completes, not on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
}

export default function App() {
  useAuthBootstrap();
  // Swap the active web manifest on /files* so the browser install
  // prompt targets the standalone "Promptly Files" PWA identity,
  // keeping the main Promptly (chat) install separate.
  useDrivePwaManifest();
  const status = useAuthStore((s) => s.status);
  useReturnAfterSignIn(status);
  const mustChangePassword = useAuthStore((s) => !!s.user?.must_change_password);
  useResumeSetup(status);
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  // The admin reaches the admin surface.
  const canManageOrg = useAuthStore((s) => s.user?.role === "admin");

  // Keep the model store's "default model" mirror in sync with
  // ``user.settings`` so every new chat starts on the user's preferred
  // model. The settings sub-object is recreated whenever the user
  // changes (login, /me refresh, preferences PATCH), which flips the
  // selector and re-runs this effect — at which point we push the
  // pair into the model store's ``setDefault``.
  // Someone else used this browser last without signing out? Purge their
  // saved drafts and choices before showing anything (R-030).
  const userId = useAuthStore((s) => s.user?.id);
  useEffect(() => {
    if (userId) noteSignedInUser(userId);
  }, [userId]);

  // No time zone saved yet: this browser's. The chat's "current time" and
  // the days in Photos for pictures without a zone of their own use it;
  // Account → Personal context can change it.
  const savedZone = useAuthStore((s) => (s.user?.settings as { timezone?: string } | undefined)?.timezone);
  useEffect(() => {
    if (!userId || savedZone) return;
    void adoptBrowserTimezone();
  }, [userId, savedZone]);

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
    // Files is for photos and documents — those rotate (R-211).
    if (window.location.pathname.startsWith("/files")) return;
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

  if (status === "reconnecting") {
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-1 bg-[var(--bg)] text-sm text-[var(--text-muted)]">
        <div className="text-[var(--text)]">Can&apos;t reach Promptly right now.</div>
        <div>It may be restarting after an update. Reconnecting…</div>
      </div>
    );
  }

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
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
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
        <Route path="*" element={<ToLogin />} />
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

  if (status === "authenticated" && mustChangePassword) {
    return (
      <Routes>
        <Route path="*" element={<ForcePasswordChangePage />} />
      </Routes>
    );
  }

  const authedApp = (
    <Routes>
      <Route path="/login" element={<Navigate to="/chat" replace />} />
      {/* The wizard resumes where it was left (R-281): a reload after
          step 1 used to drop the admin into the app with steps 2-6 lost. */}
      <Route
        path="/setup"
        element={
          isAdmin && setupInProgress() ? <SetupPage resume /> : <Navigate to="/chat" replace />
        }
      />
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
        {/* The Files shell — rail, drawer, phone tabs (WP-3.5) — wraps
            every browse view; editor pages sit outside it. */}
        <Route element={<FilesShell />}>
          <Route path="/files" element={<FilesPage />} />
          <Route path="/files/home" element={<FilesHomePage />} />
          <Route path="/files/photos" element={<PhotosPage />} />
          <Route path="/files/import" element={<ImportsPage />} />
          <Route path="/files/import/:importId" element={<ImportJobPage />} />
          <Route path="/files/photos/search" element={<PhotoSearchPage />} />
          <Route path="/files/photos/people" element={<PeoplePage />} />
          <Route path="/files/photos/people/:personId" element={<PersonPage />} />
          <Route path="/files/photos/albums" element={<PhotoAlbumsPage />} />
          <Route path="/files/photos/albums/:albumId" element={<PhotoAlbumPage />} />
          <Route path="/files/photos/memories/:memoryId" element={<MemoryPage />} />
          <Route path="/files/photos/setup" element={<PhotoSetupPage />} />
          <Route path="/files/photos/cleanup" element={<PhotoCleanupPage />} />
          <Route path="/files/photos/map" element={<PhotoMapPage />} />
          <Route path="/files/photos/places" element={<PhotoPlacesPage />} />
          <Route path="/files/photos/places/:country" element={<PhotoPlacesPage />} />
          <Route path="/files/photos/places/:country/:placeId" element={<PhotoPlacesPage />} />
          <Route path="/files/folder/:folderId" element={<FilesPage />} />
          <Route path="/files/recent" element={<RecentFilesPage />} />
          <Route path="/files/starred" element={<StarredFilesPage />} />
          <Route path="/files/shared" element={<SharedWithMePage />} />
          <Route path="/files/trash" element={<TrashPage />} />
          <Route path="/files/links" element={<SharedLinksPage />} />
          <Route path="/files/search" element={<SearchResultsPage />} />
          <Route path="/files/workspaces" element={<WorkspaceDrivesIndexPage />} />
          <Route path="/files/workspaces/:wsId" element={<WorkspaceDrivePage />} />
        </Route>
        <Route path="/files/f/:fileId" element={<FileDeepLinkPage />} />
        <Route path="/files/doc/:fileId" element={<OfficeEditorPage />} />
        <Route path="/files/sheet/:fileId" element={<OfficeEditorPage />} />
        <Route path="/files/whiteboard/:fileId" element={<OfficeEditorPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        {/* /account opens at the top (Profile); /account/<section> deep-
            links to one section — /account/security used to be the only
            address, whatever it showed (V25). */}
        <Route path="/account" element={<AccountSecurityPage />} />
        <Route path="/account/:section" element={<AccountSecurityPage />} />
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
      <UpdateBanner />
      <ToastViewport />
      <ConfirmHost />
    </>
  );
}
