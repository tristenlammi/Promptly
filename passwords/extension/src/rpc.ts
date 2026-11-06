// Messages between the extension's parts. Secrets only ever travel from the background
// to a content script at fill time, and to trusted extension pages when asked.
export const ext: typeof chrome = (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;

export type PageReport = { url: string; kinds: string[]; roles: string[]; fieldCount: number; top: boolean };

export type Candidate = { id: string; title: string; username: string; hasTotp: boolean; kind: string; downgrade: boolean; reprompt: boolean };

export type StateOut = { connected: boolean; serverUrl: string | null; hasKit: boolean; unlocked: boolean; preview: boolean; onClickOnly: boolean; deviceRequests: number };

/** A page's host, without the Public Suffix List: the popup stays light. */
export function pageHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** What a trusted extension page may ask. */
export type PageRequest =
  | { t: "state" }
  | { t: "unlock"; password: string }
  | { t: "lock" }
  | { t: "session" }
  | { t: "list"; query?: string }
  | { t: "matches"; tabId: number; url?: string }
  | { t: "item"; id: string }
  | { t: "totp"; id: string; reprompted?: boolean }
  | { t: "fill"; tabId: number; itemId: string; confirmOrigin?: string; confirmDowngrade?: boolean; confirmLookalike?: boolean; confirmCard?: boolean; confirmFrames?: string[]; reprompted?: boolean }
  | { t: "addLogin"; tabId?: number; title: string; url: string; username: string; password: string }
  | { t: "check"; password: string }
  | { t: "sync" }
  | { t: "setAccess"; onClickOnly: boolean }
  | { t: "extSettings" }
  | { t: "unlockWithSecret"; secret: string }
  | { t: "setMailCodes"; on: boolean }
  | { t: "setPin"; pin: string | null }
  | { t: "pinUnlock"; pin: string }
  | { t: "scanTabQr"; windowId?: number }
  | { t: "addTotp"; itemId: string | null; uri: string; title: string; url: string }
  | { t: "teach"; tabId: number }
  | { t: "reportForm"; tabId: number }
  | { t: "connected"; serverUrl: string; token: string; deviceId: string; userId: string }
  | { t: "activity" }
  | { t: "generate"; host?: string | null }
  | { t: "plusBase" }
  | { t: "plusAddress"; email: string; host?: string | null }
  | { t: "clipWatch"; text: string }
  | { t: "clipClear" };

export type FillOutcome =
  | { ok: true; filled: string[] }
  | { ok: false; reason: "locked" | "no-fields" | "no-frame" | "reprompt" }
  | { ok: false; reason: "confirm-origin"; origin: string }
  | { ok: false; reason: "confirm-downgrade"; origin: string }
  | { ok: false; reason: "confirm-lookalike"; origin: string; lookalike: string }
  | { ok: false; reason: "confirm-card"; frames: string[] };

/** What a content script may ask. Never a secret back, only titles for its own tab. */
export type ContentRequest =
  | { t: "pageReport"; report: PageReport }
  | { t: "hello"; url: string }
  | { t: "captured"; capture: { kind: string; username?: string; password?: string; newPassword?: string; host: string; url: string; at: number } }
  | { t: "capturedUser"; username: string }
  | { t: "submitFailed" }
  | { t: "teachResult"; rule: { host: string; username?: string; password?: string; submit?: string; otp?: string } };

/** What the inline menu frame may ask. */
export type MenuRequest =
  | { t: "menuList" }
  | { t: "menuPick"; itemId: string }
  | { t: "menuMailCode"; id: string; confirmLookalike?: boolean }
  | { t: "menuMailLink"; id: string }
  | { t: "menuGenerate"; itemId?: string }
  | { t: "menuClose" }
  | { t: "menuOpenPopup" };

export type SaveRequest = { t: "saveAnswer"; answer: "save" | "update" | "never" | "dismiss" } | { t: "saveOffer" };

/** From the background to a frame's content script. */
export type ToContent =
  | { t: "report"; fresh?: boolean }
  | { t: "doFill"; values: Record<string, string>; only?: string[] }
  | { t: "menuCheck"; itemId: string }
  | { t: "hasMenu" }
  | { t: "showSave"; kind: string }
  | { t: "hideSave" }
  | { t: "checkFailed" }
  | { t: "openMenu" }
  | { t: "fillGenerated"; password: string }
  | { t: "teachStart" }
  | { t: "describeForm" }
  | { t: "routeChanged" }
  | { t: "notice"; text: string };
