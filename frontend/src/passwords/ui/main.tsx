// Entry for the isolated /passwords page. Imports nothing from the main app's
// stores or API client, only its stylesheet.
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import "../../index.css";

import { showsPromptlyNav } from "../../lib/appLaunch";
import { webPlatform } from "./platform";
import { PromptlyFrame } from "./PromptlyNav";
import { VaultApp } from "./VaultApp";

// Follow the theme the person chose in Promptly, else the system's.
function applyTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("promptly.theme");
  } catch {
    /* no storage: use the system's */
  }
  const parsed = stored?.includes("dark") ? "dark" : stored?.includes("light") ? "light" : null;
  const dark = parsed ? parsed === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
}
applyTheme();

// A Send opens for anyone with the link, with no account and nothing of the vault loaded.
const SendView = lazy(() => import("./SendView").then((m) => ({ default: m.SendView })));
const isSend = location.pathname.startsWith("/passwords/send/");
const platform = webPlatform();
// Opened inside Promptly (a browser tab, the installed Promptly window), the
// vault keeps Promptly's navigation; as the installed Passwords app it's on
// its own. A Send is for anyone with the link, so never.
const promptlyNav = !isSend && showsPromptlyNav("passwords");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isSend ? (
      <Suspense fallback={null}>
        <SendView />
      </Suspense>
    ) : promptlyNav ? (
      <PromptlyFrame auth={platform.api.auth}>
        <VaultApp platform={platform} />
      </PromptlyFrame>
    ) : (
      <VaultApp platform={platform} />
    )}
  </StrictMode>,
);
