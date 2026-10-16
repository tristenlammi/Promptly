import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { ErrorBoundary } from "./components/system/ErrorBoundary";
import { reportUnhandledMutationError } from "./lib/mutationErrors";
import "./index.css";

// Tell Excalidraw to load its fonts + locales from our self-hosted copy
// (``public/excalidraw-assets/``, produced by
// ``scripts/copy-excalidraw-assets.mjs``) instead of the default CDN.
// Required so the workspace canvas works under Promptly's strict
// ``font-src/connect-src 'self'`` CSP. Set here — before the lazily
// mounted canvas ever reads it at font-load time.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}
window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

const queryClient = new QueryClient({
  // A failed action always says so (R-092). Dozens of mutations had no
  // error handling — admin "Disable user" and "Log out everywhere" among
  // them — so a failure looked exactly like success.
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) =>
      reportUnhandledMutationError(error, mutation),
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

const appTree = (
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
);

createRoot(document.getElementById("root")!).render(appTree);
