// Messages between the extension's parts. Secrets only ever travel from the background
// to a content script at fill time, and to trusted extension pages when asked.
export const ext: typeof chrome = (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;

export type PageReport = { url: string; origin: string; kinds: string[]; roles: string[]; fieldCount: number; top: boolean };

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
/** Minutes idle, when the browser closes, or never. */
export type LockWhen = number | "browser" | "never";
export type LockChoice = { when: LockWhen; onSleep: boolean };

export type PageRequest =
  | { t: "state" }
  | { t: "unlock"; password: string }
  | { t: "lock" }
  | { t: "session" }
  | { t: "list"; query?: string; kind?: string; favorite?: boolean; totp?: boolean }
  | { t: "counts" }
  | { t: "secretField"; id: string; field: "username" | "password"; reprompted?: boolean }
  | { t: "bookmarkTree" }
  | { t: "openBookmark"; id: string }
  | { t: "matches"; tabId: number; url?: string }
  | { t: "item"; id: string }
  | { t: "totp"; id: string; reprompted?: boolean }
  | { t: "fill"; tabId: number; itemId: string; confirmOrigin?: string; confirmDowngrade?: boolean; confirmLookalike?: boolean; confirmCard?: boolean; confirmFrames?: string[]; reprompted?: boolean }
  | { t: "addLogin"; tabId?: number; title: string; url: string; username: string; password: string }
  | { t: "check"; password: string }
  | { t: "sync" }
  | { t: "setAccess"; onClickOnly: boolean }
  | { t: "extSettings" }
  | { t: "lockChoice" }
  | { t: "setLockChoice"; when: LockWhen; onSleep: boolean }
  | { t: "unlockWithSecret"; secret: string }
  | { t: "setMailCodes"; on: boolean }
  | { t: "setPin"; pin: string | null }
  | { t: "pinUnlock"; pin: string }
  | { t: "scanTabQr"; windowId?: number }
  | { t: "addTotp"; itemId: string | null; uri: string; title: string; url: string; replace?: boolean }
  | { t: "saveOfferFor"; tabId: number }
  | { t: "saveAnswerFor"; tabId: number; answer: "save" | "update" | "never" | "dismiss" }
  | { t: "teach"; tabId: number }
  | { t: "reportForm"; tabId: number }
  | { t: "connected"; serverUrl: string; token: string; deviceId: string; userId: string }
  | { t: "activity" }
  | { t: "generate"; host?: string | null; mode?: "password" | "passphrase" | "pin" | "username" }
  | { t: "mailForTab"; tabId: number }
  | { t: "mailCodeFill"; tabId: number; id: string }
  | { t: "mailLinkOpen"; tabId: number; id: string; confirmed?: boolean }
  | { t: "bookmarkState" }
  | { t: "bookmarkSyncNow" }
  | { t: "setBookmarks"; on: boolean }
  | { t: "bookmarkAnswer"; go: boolean }
  | { t: "bookmarkExport" }
  | { t: "plusBase" }
  | { t: "plusAddress"; email: string; host?: string | null }
  | { t: "clipWatch"; text: string }
  | { t: "clipClear" }
  /** Firefox: what the on-page menu picked, and whether a page opened this panel (D-FIREFOX-1). */
  | { t: "handoffFor"; tabId: number };

export type FillOutcome =
  | { ok: true; filled: string[]; left?: string[] }
  | { ok: false; reason: "locked" | "no-fields" | "no-frame" | "reprompt" }
  | { ok: false; reason: "confirm-origin"; origin: string; fills?: string[] }
  | { ok: false; reason: "confirm-downgrade"; origin: string; fills?: string[] }
  | { ok: false; reason: "confirm-lookalike"; origin: string; lookalike: string; fills?: string[] }
  | { ok: false; reason: "confirm-card"; frames: string[]; fills?: string[] };

/** What a content script may ask. Never a secret back, only titles for its own tab. */
export type ContentRequest =
  | { t: "pageReport"; report: PageReport }
  | { t: "hello"; url: string }
  | { t: "captured"; capture: { kind: string; username?: string; password?: string; newPassword?: string; host: string; url: string; at: number } }
  | { t: "capturedUser"; username: string }
  | { t: "submitFailed" }
  | { t: "teachResult"; rule: { host: string; username?: string; password?: string; submit?: string; otp?: string } };

/** What the inline menu frame may ask. */
export type MenuRequest = { token: string } & (
  | { t: "menuList" }
  | { t: "menuPick"; itemId: string }
  | { t: "menuMailCode"; id: string }
  | { t: "menuPasskey"; key: string; credentialId: string }
  | { t: "menuMailLink"; id: string; confirmed?: boolean }
  | { t: "menuGenerate"; itemId?: string }
  | { t: "menuClose" }
  | { t: "menuOpenPopup" }
  /** Firefox: a row was clicked, so the toolbar panel opens with it at the top. */
  | { t: "menuHandoff"; itemId?: string }
  | { t: "menuSize"; h: number }
);

export type SaveRequest = { token: string } & ({ t: "saveAnswer"; answer: "save" | "update" | "never" | "dismiss" } | { t: "saveOffer" } | { t: "saveOpenPopup" });

/** From the background to a frame's content script. */
export type ToContent =
  | { t: "report"; fresh?: boolean }
  | { t: "doFill"; values: Record<string, string>; origin: string }
  | { t: "pkOfferResult"; id: number; document: string; origin: string; result: Record<string, unknown> }
  | { t: "menuCheck"; itemId: string; token: string }
  | { t: "menuResize"; h: number; token: string }
  | { t: "ownsMenu"; token: string }
  | { t: "ownsSave"; token: string }
  | { t: "showSave"; kind: string }
  | { t: "hideSave" }
  | { t: "checkFailed" }
  | { t: "openMenu" }
  | { t: "fillGenerated"; password: string; origin: string }
  | { t: "teachStart" }
  | { t: "describeForm" }
  | { t: "routeChanged" }
  | { t: "notice"; text: string };
