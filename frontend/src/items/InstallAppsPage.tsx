import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Car, CheckCircle2, ChevronDown, Download, KeyRound, Loader2, Monitor, Smartphone } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { extractError } from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { IosHomeScreenSteps } from "@/components/layout/WelcomeDialog";
import { OpenInBrowserGuide } from "@/components/pwa/OpenInBrowserGuide";
import { isStandaloneDisplay, useInstallPrompt } from "@/lib/installPrompt";
import { toast } from "@/store/toastStore";

import { porchApi } from "@/api/porch";

import { itemsApi } from "./api";
import "./ui/items.css";

/** ``/apps/install`` — every part of Promptly that installs as its own app
 *  (Promptly itself, Photos, and each app in the launcher), in one
 *  place.
 *
 *  A browser only offers to install the app whose page is open (its
 *  manifest and scope), so "Install" opens that app's own page with
 *  ``?install=1``; the install card there does the rest (Chrome / Edge /
 *  Android prompt, iPhone "Add to Home Screen" steps). */

interface Installable {
  id: string;
  name: string;
  blurb: string;
  icon: string;
  /** A page inside the app's scope; ``install=1`` is added for the card. */
  href: string | (() => Promise<string>);
}

const CORE: Installable[] = [
  {
    id: "promptly",
    name: "Promptly",
    blurb: "Chat, workspaces and everything else — the whole of Promptly.",
    icon: "/pwa-192.png",
    href: "/chat",
  },
  {
    id: "photos",
    name: "Promptly Photos",
    blurb: "Your photo library — albums, people, places and search.",
    icon: "/pwa-photos-192.png",
    href: "/photos/",
  },
  {
    id: "rooms",
    name: "Promptly Rooms",
    blurb: "Chat with your family and friends — spaces, rooms and messages.",
    icon: "/item-icons/rooms-192.png",
    href: "/rooms/",
  },
  {
    id: "calendar",
    name: "Promptly Calendar",
    blurb: "Your calendar, shared with family and friends — events, invites and reminders.",
    icon: "/item-icons/calendar-192.png",
    href: "/calendar/",
  },
  {
    id: "mail",
    name: "Promptly Mail",
    blurb: "All your email in one calm place, with an AI to ask.",
    icon: "/item-icons/mail-192.png",
    href: "/mail/",
  },
  {
    id: "notes",
    name: "Promptly Notes",
    blurb: "Quick notes and checklists — pin, colour, label, and they work with no signal.",
    icon: "/item-icons/notes-192.png",
    href: "/notes/",
  },
  {
    id: "passwords",
    name: "Promptly Passwords",
    blurb: "Your passwords and 2FA codes, end-to-end encrypted. Your server can't read them.",
    icon: "/item-icons/passwords-192.png",
    href: "/passwords/",
  },
  // Porch (listed only for people it's turned on for)
  {
    id: "porch",
    name: "Porch",
    blurb: "Share photos and news with your family and friends here, through groups.",
    icon: "/item-icons/porch-192.png",
    href: "/porch/",
  },
];

function withInstall(href: string): string {
  return href + (href.includes("?") ? "&" : "?") + "install=1";
}

function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

/** "Promptly for Android": one app that puts every part of Promptly on the
 *  phone as its own icon (P Rooms, P Workout…), full screen — no browser
 *  install steps. Shown on Android when the server has the APK. */
function useAndroidApk() {
  return useQuery({
    queryKey: ["android-apk"],
    queryFn: async () => {
      const r = await fetch("/downloads/Promptly.json", { cache: "no-store" });
      return r.ok ? ((await r.json()) as { version: string; size_bytes: number }) : null;
    },
    staleTime: 60_000,
  }).data;
}

function AndroidAppCard({ kinds, bare }: { kinds: string[]; bare?: boolean }) {
  const apk = useAndroidApk();
  if (!apk) return null;
  // The phone pre-ticks these in its app picker: the built-in apps plus every
  // app you've added here.
  const apps = ["photos", "rooms", "calendar", "mail", "maps", ...kinds].join(",");
  const setup = `promptlyapp://setup?server=${encodeURIComponent(location.origin)}&apps=${encodeURIComponent(apps)}`;
  return (
    <section className={bare ? "flex flex-col gap-3" : "flex flex-col gap-3 rounded-2xl border border-[var(--accent)]/40 bg-[var(--surface)] p-4"}>
      <div className="flex items-center gap-3">
        {!bare && <img src="/pwa-192.png" alt="" className="h-12 w-12 shrink-0 rounded-2xl" />}
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
            <Smartphone className="h-4 w-4 text-[var(--accent-text)]" /> Promptly for Android
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            Promptly on your phone, plus the apps you choose as their own icons — P Rooms, P Workout… — full screen,
            with notifications and photo backup.
          </p>
        </div>
      </div>
      <ol className="flex flex-col gap-2 text-sm text-[var(--text)]">
        <li className="flex flex-wrap items-center gap-2">
          <span>1.</span>
          <a
            href="/downloads/Promptly.apk"
            download
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 font-semibold text-white"
          >
            <Download className="h-4 w-4" /> Download ({(apk.size_bytes / 1048576).toFixed(1)} MB)
          </a>
        </li>
        <li>2. Open the download to install it. If your phone asks, allow installs from your browser.</li>
        <li className="flex flex-wrap items-center gap-2">
          <span>3.</span>
          <a href={setup} className="inline-flex h-9 items-center rounded-xl border border-[var(--border)] px-3.5 font-medium hover:bg-[var(--hover)]">
            Set up the app
          </a>
          <span className="text-xs text-[var(--text-muted)]">connects it to this Promptly</span>
        </li>
      </ol>
    </section>
  );
}

/** P Maps on a car's screen: Android Auto only runs apps installed from Google Play, so
 *  the car needs the Play copy of Promptly for Android, not the download above. */
function AndroidAutoCard() {
  return (
    <section aria-labelledby="android-auto-title" className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center gap-3">
        <img src="/item-icons/maps-192.png" alt="" className="h-12 w-12 shrink-0 rounded-2xl" />
        <div className="min-w-0 flex-1">
          <h2 id="android-auto-title" className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
            <Car className="h-4 w-4 text-[var(--accent-text)]" /> P Maps in your car (Android Auto)
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            Turn-by-turn on the car&apos;s screen, with your places, traffic and the car&apos;s microphone. Cars only show apps
            installed from Google Play, so this needs the Play copy of Promptly for Android. It&apos;s the same app, kept up to
            date by Play instead of this server.
          </p>
        </div>
      </div>
      <ol className="flex flex-col gap-2 text-sm text-[var(--text)]">
        <li>
          1. Ask whoever runs this Promptly to add your Google account as a tester. You&apos;ll get a testing link.
        </li>
        <li>
          2. On your phone, open the link, choose <b>Become a tester</b>, then <b>Download it on Google Play</b>.
        </li>
        <li>
          3. Already have the app from this page? Uninstall it first: Play can&apos;t replace a copy signed differently. Then
          open P Maps once and sign in again (photo backup too).
        </li>
        <li>
          4. Plug your phone into the car. <b>P Maps</b> appears in Android Auto&apos;s apps; if not, look under Android Auto →
          Customise launcher.
        </li>
      </ol>
    </section>
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isWindows(): boolean {
  return /windows/i.test(navigator.userAgent);
}

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const DOWNLOAD_BUTTON = "inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 font-semibold text-white";

/** A version file in /downloads, or null if this server doesn't have that download. */
function useDownloadInfo<T>(file: string) {
  return useQuery({
    queryKey: ["download-info", file],
    queryFn: async () => {
      const r = await fetch(`/downloads/${file}`, { cache: "no-store" });
      return r.ok ? ((await r.json()) as T) : null;
    },
    retry: false,
    staleTime: 60_000,
  }).data;
}

/** Promptly Passwords for Windows: quick search, Windows Hello and typing logins into other
 *  programs. Not code-signed yet, so Windows warns about it. */
function WindowsPasswordsCard() {
  const info = useDownloadInfo<{ version: string; size_bytes: number }>("PromptlyPasswords.json");
  if (!info) return null;
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-[var(--accent)]/40 bg-[var(--surface)] p-4">
      <div className="flex items-center gap-3">
        <img src="/item-icons/passwords-192.png" alt="" className="h-12 w-12 shrink-0 rounded-2xl" />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
            <Monitor className="h-4 w-4 text-[var(--accent-text)]" /> Promptly Passwords for Windows
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            Your vault in its own window, with Windows Hello, quick search on Ctrl+Shift+Space, and typing logins into other
            programs. Version {info.version}.
          </p>
        </div>
      </div>
      <ol className="flex flex-col gap-2 text-sm text-[var(--text)]">
        <li className="flex flex-wrap items-center gap-2">
          <span>1.</span>
          <a href="/downloads/PromptlyPasswords-Setup.exe" download className={DOWNLOAD_BUTTON}>
            <Download className="h-4 w-4" /> Download ({megabytes(info.size_bytes)})
          </a>
        </li>
        <li>
          2. Open the download. This build isn't code-signed yet, so Windows may say <b>Windows protected your PC</b>. Choose{" "}
          <b>More info</b>, then <b>Run anyway</b>. It installs for you alone and doesn't ask for administrator rights.
        </li>
        <li>
          3. Open it and enter this address: <code className="font-mono text-xs">{location.origin}</code>
        </li>
      </ol>
    </section>
  );
}

type ExtensionInfo = { version: string; chrome: { size_bytes: number }; firefox: { size_bytes: number }; firefox_signed?: { size_bytes: number } };

const CHROME_STORE_URL = "https://chromewebstore.google.com/detail/promptly-passwords/ipiljpicohcmkpnblgblpgdekjoemghj";

/** The browser extension: the Chrome Web Store for Chromium browsers (a zip by hand as a fallback); Firefox from here. */
function BrowserExtensionCard() {
  const info = useDownloadInfo<ExtensionInfo>("PromptlyPasswordsExtension.json");
  if (!info) return null;
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex items-center gap-3">
        <img src="/item-icons/passwords-192.png" alt="" className="h-12 w-12 shrink-0 rounded-2xl" />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
            <KeyRound className="h-4 w-4 text-[var(--accent-text)]" /> Promptly Passwords browser extension
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            Fills your logins, 2FA codes and passkeys on websites. On Chrome, Edge and Brave it comes from the Chrome Web Store and
            keeps itself up to date.{" "}
            {info.firefox_signed ? "On Firefox it installs from here and updates itself too." : "On Firefox it's installed by hand for now."}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2 text-sm text-[var(--text)]">
        <h3 className="font-semibold">Chrome, Edge, Brave and other Chromium browsers</h3>
        <ol className="flex flex-col gap-2">
          <li className="flex flex-wrap items-center gap-2">
            <span>1.</span>
            <a href={CHROME_STORE_URL} target="_blank" rel="noopener noreferrer" className={DOWNLOAD_BUTTON} data-testid="chrome-store">
              <Download className="h-4 w-4" /> Add to Chrome
            </a>
          </li>
          <li>
            2. Choose <b>Add to Chrome</b> on the store page. In Edge, choose <b>Allow extensions from other stores</b> first, then <b>Get</b>.
          </li>
          <li>3. Open it from the puzzle-piece menu and enter this address: <code className="font-mono text-xs">{location.origin}</code></li>
        </ol>
        <details className="text-xs text-[var(--text-muted)]">
          <summary className="cursor-pointer">Can't use the store? Install it by hand (version {info.version})</summary>
          <ol className="mt-2 flex flex-col gap-2">
            <li className="flex flex-wrap items-center gap-2">
              <span>1.</span>
              <a href="/downloads/promptly-passwords-chrome.zip" download className={DOWNLOAD_BUTTON}>
                <Download className="h-4 w-4" /> Download ({megabytes(info.chrome.size_bytes)})
              </a>
            </li>
            <li>2. Unzip it to a folder you'll keep. The browser goes on using that folder, and it won't update itself.</li>
            <li>
              3. Go to <code className="font-mono">chrome://extensions</code> (in Edge, <code className="font-mono">edge://extensions</code>) and turn on{" "}
              <b>Developer mode</b>.
            </li>
            <li>
              4. Choose <b>Load unpacked</b> and pick the folder.
            </li>
          </ol>
        </details>
        <h3 className="mt-1 font-semibold">Firefox</h3>
        {info.firefox_signed ? (
          <ol className="flex flex-col gap-2">
            <li className="flex flex-wrap items-center gap-2">
              <span>1.</span>
              {/* No download attribute: Firefox installs a signed add-on it's sent from a link. */}
              <a href="/downloads/promptly-passwords-firefox.xpi" className={DOWNLOAD_BUTTON} data-testid="firefox-install">
                <Download className="h-4 w-4" /> Install in Firefox ({megabytes(info.firefox_signed.size_bytes)})
              </a>
            </li>
            <li>
              2. Firefox asks whether to let this site install it: choose <b>Continue to installation</b>, then <b>Add</b>.
            </li>
            <li>It's signed by Mozilla, and Firefox keeps it up to date from then on.</li>
          </ol>
        ) : (
          <ol className="flex flex-col gap-2">
            <li className="flex flex-wrap items-center gap-2">
              <span>1.</span>
              <a href="/downloads/promptly-passwords-firefox.zip" download className={DOWNLOAD_BUTTON}>
                <Download className="h-4 w-4" /> Download ({megabytes(info.firefox.size_bytes)})
              </a>
            </li>
            <li>
              2. Go to <code className="font-mono text-xs">about:debugging#/runtime/this-firefox</code>, choose <b>Load Temporary Add-on</b>, and pick the zip.
            </li>
            <li>Firefox removes it when it closes, until there's a signed version.</li>
          </ol>
        )}
      </div>
    </section>
  );
}

export function InstallAppsPage() {
  const navigate = useNavigate();
  const { data: apps, isLoading } = useQuery({ queryKey: ["apps-launcher"], queryFn: itemsApi.launcher });
  const { data: porchOn } = useQuery({ queryKey: ["porch", "available"], queryFn: porchApi.available, staleTime: 5 * 60_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const install = useInstallPrompt();
  const standalone = install.standalone || install.installed;
  const ios = isIos();
  const android = isAndroid();
  const device = ios ? (/ipad/i.test(navigator.userAgent) ? "iPad" : "iPhone") : android ? "phone" : "computer";
  const apkReady = !!useAndroidApk();
  // Inside an installed app a page just opens in the same app window, where
  // the browser won't offer an install: hand it to the browser instead.
  const [handoff, setHandoff] = useState<{ row: Installable; url: string } | null>(null);

  const appRows: Installable[] = (apps ?? []).map((a) => ({
    id: `item:${a.kind}`,
    name: a.name,
    blurb: a.tagline,
    icon: `/item-icons/${a.kind}-192.png`,
    // Each app installs from its own file's page (/app/<file>/).
    href: async () => `/app/${(await itemsApi.openApp(a.kind)).file_id}/`,
  }));

  const go = async (row: Installable, install: boolean) => {
    setBusy(row.id + (install ? ":i" : ":o"));
    try {
      const href = typeof row.href === "string" ? row.href : await row.href();
      if (install && isStandaloneDisplay()) {
        setHandoff({ row, url: withInstall(href) });
        setBusy(null);
        return;
      }
      // A full page load: the browser must read that app's manifest.
      window.location.assign(install ? withInstall(href) : href);
    } catch (err) {
      toast.error(extractError(err));
      setBusy(null);
    }
  };

  const rowEl = (row: Installable) => (
    <li key={row.id} className="flex items-center gap-3 px-4 py-3">
      <img src={row.icon} alt="" className="h-12 w-12 shrink-0 rounded-2xl shadow-[var(--shadow-sm)]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[var(--text)]">{row.name}</p>
        <p className="line-clamp-2 text-xs text-[var(--text-muted)]">{row.blurb}</p>
      </div>
      <button
        type="button"
        onClick={() => go(row, false)}
        aria-label={`Open ${row.name}`}
        title="Open"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
      >
        <ArrowUpRight className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => go(row, true)}
        disabled={busy !== null}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy === row.id + ":i" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Install
      </button>
    </li>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopNav title="Install apps" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
          <section
            id="this-device"
            aria-labelledby="this-device-title"
            className="flex flex-col gap-3 rounded-2xl border border-[var(--accent)]/40 bg-[var(--surface)] p-4"
            data-testid="install-this-device"
          >
            <div className="flex items-center gap-3">
              <img src="/pwa-192.png" alt="" className="h-12 w-12 shrink-0 rounded-2xl" />
              <div className="min-w-0 flex-1">
                <h2 id="this-device-title" className="text-base font-semibold text-[var(--text)]">
                  {standalone ? "Promptly is installed" : `Install Promptly on this ${device}`}
                </h2>
                <p className="text-xs text-[var(--text-muted)]">
                  {standalone
                    ? "You're using it as an app right now."
                    : "Recommended. It opens full screen with its own icon, and can send you message alerts."}
                </p>
              </div>
            </div>
            {standalone ? (
              <p className="flex items-center gap-2 text-sm text-[var(--text)]">
                <CheckCircle2 className="h-4 w-4 text-[var(--success)]" aria-hidden /> Nothing more to do here.
              </p>
            ) : ios ? (
              <IosHomeScreenSteps />
            ) : android && apkReady ? (
              <AndroidAppCard kinds={(apps ?? []).map((a) => a.kind)} bare />
            ) : (
              <div className="flex flex-col gap-2 text-sm text-[var(--text)]">
                <button
                  type="button"
                  onClick={() => (install.canPrompt ? void install.prompt() : void go(CORE[0], true))}
                  disabled={busy !== null}
                  className={DOWNLOAD_BUTTON + " self-start disabled:opacity-60"}
                >
                  {busy === "promptly:i" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Install Promptly
                </button>
                <p className="text-xs text-[var(--text-muted)]">
                  {android
                    ? "If nothing appears, open Chrome's ⋮ menu and choose Install app or Add to Home screen."
                    : "If nothing appears, look for the install icon at the right of the address bar, or your browser's menu → Install Promptly."}
                </p>
              </div>
            )}
          </section>

          <details className="group rounded-2xl border border-[var(--border)] bg-[var(--surface)]" data-testid="install-more">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-[var(--text)] [&::-webkit-details-marker]:hidden">
              <ChevronDown className="h-4 w-4 transition group-open:rotate-180" aria-hidden />
              More: each app on its own{android ? ", Android Auto" : ""}{!android && !ios ? ", passwords extension" : ""}
            </summary>
            <div className="flex flex-col gap-6 border-t border-[var(--border)] p-4">
              <p className="text-sm text-[var(--text-muted)]">
                Put any part of Promptly on your home screen or desktop as its own app — its own icon and window, with no
                Promptly menus around it. Everything stays in your Promptly, so search and chats still see it.
                {ios && " On iPhone and iPad: tap Install, then Share → Add to Home Screen on the page that opens."}
              </p>
              {!ios && <AndroidAutoCard />}
              {isWindows() && <WindowsPasswordsCard />}
              {!android && !ios && <BrowserExtensionCard />}

              <section className="flex flex-col gap-2">
                <h2 className="px-1 text-sm font-semibold text-[var(--text)]">Promptly</h2>
                <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                  {CORE.filter((a) => a.id !== "porch" || porchOn === true).map(rowEl)}
                </ul>
              </section>

              <section className="flex flex-col gap-2">
                <h2 className="px-1 text-sm font-semibold text-[var(--text)]">Your apps</h2>
                {isLoading ? (
                  <div className="flex justify-center py-8 text-[var(--text-muted)]">
                    <Loader2 className="h-5 w-5 animate-spin" />
                  </div>
                ) : appRows.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
                    Apps you add from the store show up here too.{" "}
                    <button type="button" onClick={() => navigate("/apps/store")} className="font-medium text-[var(--accent-text)]">
                      Get apps
                    </button>
                  </div>
                ) : (
                  <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                    {appRows.map(rowEl)}
                  </ul>
                )}
              </section>
            </div>
          </details>
        </div>
      </div>
      {handoff && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => setHandoff(null)}>
          <div
            role="dialog"
            aria-label={`Install ${handoff.row.name}`}
            className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <img src={handoff.row.icon} alt="" className="h-12 w-12 shrink-0 rounded-2xl" />
              <h2 className="flex-1 text-base font-semibold text-[var(--text)]">Install {handoff.row.name}</h2>
              <button type="button" onClick={() => setHandoff(null)} className="rounded-lg px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]">
                Close
              </button>
            </div>
            <OpenInBrowserGuide appName={handoff.row.name} url={handoff.url} />
          </div>
        </div>
      )}
    </div>
  );
}
