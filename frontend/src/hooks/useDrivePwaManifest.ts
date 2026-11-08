import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Swaps the active ``<link rel="manifest">`` based on the current
 * route so the browser's install prompt targets the right PWA:
 *
 *   - ``/photos*``  → ``/photos.webmanifest``   (Promptly Photos)
 *   - ``/rooms*``   → ``/rooms.webmanifest``    (Promptly Rooms)
 *   - ``/calendar*`` → ``/calendar.webmanifest`` (Promptly Calendar)
 *   - anywhere else → ``/manifest.webmanifest`` (Promptly — Files included)
 *
 * Why two manifests? Chrome's install UI lets a site register multiple
 * distinct "app identities" as long as each manifest has a unique
 * ``id`` and its own ``start_url``. The two installed icons then open
 * into different default URLs, giving the user genuine "two apps"
 * home-screen behaviour without us splitting the codebase.
 *
 * Scopes are intentionally disjoint:
 *   - Promptly (main): ``scope: "/"``
 *   - Promptly Photos: ``scope: "/photos/"`` — the standalone app at
 *     ``/photos``; ``/files/photos`` is Photos inside Promptly's Files and
 *     belongs to the main app.
 *
 * Without a narrow scope Chrome treats an already-installed Promptly PWA
 * as "the app that owns /photos" and refuses to fire a second
 * ``beforeinstallprompt`` for the Photos manifest. Non-Photos URLs opened
 * from inside the Photos app open in the browser instead — correct, since
 * they belong to Promptly.
 *
 * Promptly Files used to be its own installable app (``/files.webmanifest``,
 * scope ``/files/``). It's no longer advertised — Photos is the separate
 * app now and Files is part of Promptly — but ``public/files.webmanifest``
 * stays on disk so anyone who already installed it keeps a working app.
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
    // An item installed as its own app (/app/<id>/) sets its own manifest.
    if (location.pathname.startsWith("/app/")) return;
    const onPhotos =
      location.pathname === "/photos" || location.pathname.startsWith("/photos/");
    const onRooms =
      location.pathname === "/rooms" || location.pathname.startsWith("/rooms/");
    if (onRooms) {
      // Promptly Rooms — its own app, scope ``/rooms/``.
      setManifestHref("/rooms.webmanifest");
      setAppleTouchIconHref("/item-icons/rooms-apple-180.png");
      setAppleMobileTitle("Promptly Rooms");
      return;
    }
    if (location.pathname === "/mail" || location.pathname.startsWith("/mail/")) {
      // Mail: its own app, scope ``/mail/``.
      setManifestHref("/mail.webmanifest");
      setAppleTouchIconHref("/item-icons/mail-apple-180.png");
      setAppleMobileTitle("Mail");
      return;
    }
    if (location.pathname === "/maps" || location.pathname.startsWith("/maps/")) {
      // P Maps: its own app, scope ``/maps/``.
      setManifestHref("/maps.webmanifest");
      setAppleTouchIconHref("/item-icons/maps-apple-180.png");
      setAppleMobileTitle("P Maps");
      return;
    }
    if (location.pathname === "/porch" || location.pathname.startsWith("/porch/")) {
      // Porch: its own app, scope ``/porch/``.
      setManifestHref("/porch.webmanifest");
      setAppleTouchIconHref("/item-icons/porch-apple-180.png");
      setAppleMobileTitle("Porch");
      return;
    }
    const onCalendar =
      location.pathname === "/calendar" || location.pathname.startsWith("/calendar/");
    if (onCalendar) {
      // Promptly Calendar — its own app, scope ``/calendar/``.
      setManifestHref("/calendar.webmanifest");
      setAppleTouchIconHref("/item-icons/calendar-apple-180.png");
      setAppleMobileTitle("Promptly Calendar");
      return;
    }
    setManifestHref(onPhotos ? "/photos.webmanifest" : "/manifest.webmanifest");
    setAppleTouchIconHref(onPhotos ? "/apple-touch-icon-photos.png" : "/apple-touch-icon.png");
    setAppleMobileTitle(onPhotos ? "Promptly Photos" : "Promptly");
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
