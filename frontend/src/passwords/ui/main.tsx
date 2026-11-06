// Entry for the isolated /passwords page. Imports nothing from the main app's
// stores or API client, only its stylesheet.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../../index.css";

import { webPlatform } from "./platform";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VaultApp platform={webPlatform()} />
  </StrictMode>,
);
