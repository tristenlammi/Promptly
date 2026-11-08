/** Developer pages: on in a dev build, or when localStorage "promptly.dev"
 *  names them (the e2e suite sets "voice" for the voice engine harness). */
export function voiceHarnessEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    return window.localStorage.getItem("promptly.dev") === "voice";
  } catch {
    return false;
  }
}
