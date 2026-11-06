// Messages between the extension's parts. Secrets only ever travel from the background
// to a content script at fill time, and to trusted extension pages when asked.
export const ext: typeof chrome = (globalThis as unknown as { browser?: typeof chrome }).browser ?? chrome;

export type PageReport = { url: string; kinds: string[]; roles: string[]; fieldCount: number; top: boolean };

export type Candidate = { id: string; title: string; username: string; hasTotp: boolean; kind: string; downgrade: boolean; reprompt: boolean };

export type StateOut = { connected: boolean; serverUrl: string | null; hasKit: boolean; unlocked: boolean; preview: boolean; onClickOnly: boolean };

/** What a trusted extension page may ask. */
export type PageRequest =
  | { t: "state" }
  | { t: "unlock"; password: string }
  | { t: "lock" }
  | { t: "session" }
  | { t: "list"; query?: string }
  | { t: "matches"; tabId: number; url?: string }
  | { t: "item"; id: string }
  | { t: "totp"; id: string }
  | { t: "fill"; tabId: number; itemId: string; confirmOrigin?: string; confirmDowngrade?: boolean; confirmLookalike?: boolean; confirmCard?: boolean; reprompted?: boolean }
  | { t: "addLogin"; tabId?: number; title: string; url: string; username: string; password: string }
  | { t: "check"; password: string }
  | { t: "sync" }
  | { t: "setAccess"; onClickOnly: boolean }
  | { t: "teach"; tabId: number }
  | { t: "reportForm"; tabId: number }
  | { t: "connected"; serverUrl: string; token: string; deviceId: string; userId: string };

export type FillOutcome =
  | { ok: true; filled: string[]; totpCopied?: boolean }
  | { ok: false; reason: "locked" | "no-fields" | "no-frame" | "reprompt" }
  | { ok: false; reason: "confirm-origin"; origin: string }
  | { ok: false; reason: "confirm-downgrade"; origin: string }
  | { ok: false; reason: "confirm-lookalike"; origin: string; lookalike: string }
  | { ok: false; reason: "confirm-card" };

/** What a content script may ask. Never a secret back, only titles for its own tab. */
export type ContentRequest =
  | { t: "pageReport"; report: PageReport }
  | { t: "hello"; url: string }
  | { t: "captured"; capture: { kind: string; username?: string; password?: string; newPassword?: string; host: string; url: string; at: number } }
  | { t: "submitFailed" }
  | { t: "teachResult"; rule: { host: string; username?: string; password?: string; submit?: string; otp?: string } };

/** What the inline menu frame may ask. */
export type MenuRequest =
  | { t: "menuList" }
  | { t: "menuPick"; itemId: string }
  | { t: "menuGenerate" }
  | { t: "menuClose" }
  | { t: "menuOpenPopup" };

export type SaveRequest = { t: "saveAnswer"; answer: "save" | "update" | "never" | "dismiss" } | { t: "saveOffer" };

/** From the background to a frame's content script. */
export type ToContent =
  | { t: "report" }
  | { t: "doFill"; values: Record<string, string>; only?: string[] }
  | { t: "menuCheck"; itemId: string }
  | { t: "showSave" }
  | { t: "checkFailed" }
  | { t: "openMenu" }
  | { t: "fillGenerated"; password: string }
  | { t: "teachStart" }
  | { t: "describeForm" }
  | { t: "copy"; text: string };
