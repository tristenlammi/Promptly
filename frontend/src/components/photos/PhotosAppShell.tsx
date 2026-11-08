import { useEffect } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { UploadProgressPanel } from "@/components/files/UploadProgressPanel";
import { UploadQueueWatcher } from "@/components/files/UploadQueueWatcher";
import { NetworkStatusToast } from "@/components/layout/NetworkStatusToast";
import { PhotosShell } from "@/components/photos/PhotosShell";
import { APP_PHOTOS_BASE, PhotosBaseProvider } from "@/components/photos/photosPath";
import { InstallFromLink } from "@/components/pwa/InstallFromLink";

/**
 * ``/photos/*`` — Promptly Photos as **its own installed app**
 * (``/photos.webmanifest``, scope ``/photos/``): the same Photos pages as
 * ``/files/photos`` but with none of Promptly's navigation — no sidebar,
 * no Files rail. Phones get bottom tabs (PhotosShell ``app``); desktop
 * keeps the Photos menu row. ``?install=1`` shows the install card.
 *
 * Signed-out visitors are sent to sign in and brought back (App.tsx's
 * ToLogin remembers the address); the manifest + iOS icon/title are set
 * by ``useDrivePwaManifest``.
 */
export function PhotosAppShell() {
  const location = useLocation();

  useEffect(() => {
    const before = document.title;
    document.title = "Promptly Photos";
    return () => {
      document.title = before;
    };
  }, []);

  // ``/photos`` → ``/photos/``: the app's scope is ``/photos/``.
  if (location.pathname === APP_PHOTOS_BASE) {
    return <Navigate replace to={{ pathname: `${APP_PHOTOS_BASE}/`, search: location.search, hash: location.hash }} />;
  }

  return (
    <PhotosBaseProvider base={APP_PHOTOS_BASE}>
      <div className="flex h-[100dvh] flex-col bg-[var(--bg)] pl-safe pr-safe pt-safe">
        <main id="main" className="flex min-h-0 flex-1 flex-col">
          <PhotosShell app />
        </main>
      </div>
      <InstallFromLink
        appName="Promptly Photos"
        iconSrc="/pwa-photos-192.png"
        description="Your photo library as its own app — its own icon and window, no Promptly menus."
      />
      <NetworkStatusToast />
      <UploadQueueWatcher />
      <UploadProgressPanel />
    </PhotosBaseProvider>
  );

}

/**
 * ``/photos/*`` opened from inside Promptly (a browser tab, the installed
 * Promptly window): the same pages inside Promptly's layout (App.tsx wraps
 * this in AppLayout), at the same address, so the browser still offers to
 * install Promptly Photos from here.
 */
export function PhotosInPromptly() {
  const location = useLocation();
  if (location.pathname === APP_PHOTOS_BASE) {
    return <Navigate replace to={{ pathname: `${APP_PHOTOS_BASE}/`, search: location.search, hash: location.hash }} />;
  }
  return (
    <PhotosBaseProvider base={APP_PHOTOS_BASE}>
      <PhotosShell />
    </PhotosBaseProvider>
  );
}
