import { useState } from "react";
import { SignIn, SignUp } from "@clerk/clerk-react";

/**
 * Sign-in / sign-up screen shown when ``AUTH_PROVIDER=clerk`` and the visitor
 * is signed out. Uses Clerk's prebuilt components with ``routing="hash"`` so
 * Clerk manages its own multi-step flow in the URL hash without colliding with
 * the app's ``BrowserRouter`` path routing.
 */
export function ClerkAuthPage() {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  return (
    <div className="flex min-h-screen w-screen flex-col items-center justify-center gap-4 bg-[var(--bg)] p-4">
      {mode === "sign-in" ? (
        <SignIn routing="hash" />
      ) : (
        <SignUp routing="hash" />
      )}
      <button
        type="button"
        onClick={() =>
          setMode((m) => (m === "sign-in" ? "sign-up" : "sign-in"))
        }
        className="text-sm text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        {mode === "sign-in"
          ? "Need an account? Sign up"
          : "Have an account? Sign in"}
      </button>
    </div>
  );
}
