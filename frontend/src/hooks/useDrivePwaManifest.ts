import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Swaps the active ``<link rel="manifest">`` based on the current
 * route so the browser's install prompt targets the right PWA:
 *
 *   - ``/files*``           → ``/files.webmanifest``  (Promptly Files)
 *   - anywhere else        → ``/manifest.webmanifest`` (Promptly)
 *
 * Why two manifests? Chrome's install UI lets a site register multiple
 * distinct "app identities" as long as each manifest has a unique
 * ``id`` and its own ``start_url``. The two installed icons then open
 * into different default URLs, giving the user genuine "two apps"
 * home-screen behaviour without us splitting the codebase.
 *
 * Both manifests intentionally share ``scope: "/"`` — we need auth
 * routes like ``/login`` to stay in-scope so an installed Promptly
 * Files PWA can still log the user in without opening a browser tab.
 *
 * On iOS Safari the manifest is largely ignored for "Add to Home
 * Screen", so we also swap a couple of apple-specific meta tags
 * (``apple-touch-icon`` + ``apple-mobile-web-app-title``) so the
 * home-screen icon and app name match whichever surface the user is
 * currently looking at when they save the page.
 */
export function useDrivePwaManifest(): void {
  const location = useLocation();

  useEffect(() => {
    const onDrive =
      location.pathname === "/files" ||
      location.pathname.startsWith("/files/");

    setManifestHref(
      onDrive ? "/files.webmanifest" : "/manifest.webmanifest"
    );
    setAppleTouchIconHref(
      onDrive ? "/apple-touch-icon-files.png" : "/apple-touch-icon.png"
    );
    setAppleMobileTitle(onDrive ? "Promptly Files" : "Promptly");
  }, [location.pathname]);
}

function setManifestHref(href: string) {
  // vite-plugin-pwa injects the initial ``<link rel="manifest">``,
  // so there's usually exactly one. Create it on the fly if not
  // (e.g. during dev when VitePWA ``devOptions.enabled`` is false).
  let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "manifest";
    document.head.appendChild(link);
  }
  if (link.getAttribute("href") !== href) {
    link.setAttribute("href", href);
  }
}

function setAppleTouchIconHref(href: string) {
  let link = document.querySelector<HTMLLinkElement>(
    'link[rel="apple-touch-icon"]'
  );
  if (!link) {
    link = document.createElement("link");
    link.rel = "apple-touch-icon";
    document.head.appendChild(link);
  }
  if (link.getAttribute("href") !== href) {
    link.setAttribute("href", href);
  }
}

function setAppleMobileTitle(title: string) {
  let meta = document.querySelector<HTMLMetaElement>(
    'meta[name="apple-mobile-web-app-title"]'
  );
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "apple-mobile-web-app-title");
    document.head.appendChild(meta);
  }
  if (meta.getAttribute("content") !== title) {
    meta.setAttribute("content", title);
  }
}
