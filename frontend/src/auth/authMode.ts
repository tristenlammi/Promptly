/**
 * Reversible auth-provider switch (frontend half of the AUTH_PROVIDER seam).
 *
 * ``custom`` (default): the built-in username/password + JWT flow — unchanged.
 * ``clerk``: authenticate via Clerk; ``ClerkBridge`` feeds Clerk's session
 * token into the existing axios client so every API call keeps working.
 *
 * Both values are baked at build time (Vite inlines ``import.meta.env``), so
 * the default production build is byte-identical to today unless the frontend
 * image is built with ``VITE_AUTH_PROVIDER=clerk`` + a publishable key.
 */
export const AUTH_PROVIDER = ((import.meta.env.VITE_AUTH_PROVIDER as string) ??
  "custom") as "custom" | "clerk";

export const CLERK_PUBLISHABLE_KEY =
  (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string) ?? "";

/** True only when Clerk is selected AND a publishable key is present. Guards
 *  against a half-configured build silently mounting a keyless ClerkProvider. */
export const isClerkAuth =
  AUTH_PROVIDER === "clerk" && CLERK_PUBLISHABLE_KEY.length > 0;
