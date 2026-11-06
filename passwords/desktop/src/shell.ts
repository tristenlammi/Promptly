// The app's own vault client, for what happens outside the vault screens: quick search, the
// scheduled backup and the SSH agent. It reads the same encrypted copy as the screens do, like
// the extension's background page (DECISIONS D14). Keys live here in this page's memory, and
// only here: Rust is handed one secret at a time, when a person has asked for it.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import type { DeviceRequestOut, VaultApi } from "../../../frontend/src/passwords/core/api";
import { encryptedExport } from "../../../frontend/src/passwords/core/exporter";
import { hostOf } from "../../../frontend/src/passwords/core/match";
import type { Item } from "../../../frontend/src/passwords/core/model";
import { ed25519Sign } from "../../../frontend/src/passwords/core/primitives";
import type { LocalStore } from "../../../frontend/src/passwords/core/store";
import { totpCode } from "../../../frontend/src/passwords/core/totp";
import { VaultClient } from "../../../frontend/src/passwords/core/vault";
import { native } from "./native";
import { fromB64u, toB64u, usableIdentity } from "./ssh";

const BACKUP_CHECK_MS = 15 * 60 * 1000;
const DEVICE_CHECK_MS = 20 * 1000;

function touchIdleTimer() {
  // The vault's idle lock counts key presses. Using quick search counts as using the vault.
  window.dispatchEvent(new Event("keydown"));
}

async function clipboardSeconds(store: LocalStore): Promise<number> {
  const s = await store.getMeta<{ clipboardSeconds?: number }>("settings");
  return s?.clipboardSeconds ?? 30;
}

function mainSecret(i: Item): string | undefined {
  const b = i.body;
  return b.password ?? b.cardNumber ?? b.apiKey ?? b.wifiPassword ?? b.sshPrivate ?? b.notes;
}

function subtitle(i: Item): string {
  const b = i.body;
  return b.username || (b.urls?.[0]?.url ? hostOf(b.urls[0].url) ?? "" : "") || b.email || b.kind;
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export class Shell {
  vault: VaultClient;
  private secret: Uint8Array | null = null;
  private session: string | null = null;
  private changed: ReturnType<typeof setTimeout> | null = null;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private deviceTimer: ReturnType<typeof setInterval> | null = null;
  private knownRequests = new Set<string>();
  /** New devices waiting to join. The main window shows these. */
  onDeviceRequests?: (requests: DeviceRequestOut[]) => void;

  constructor(
    public api: VaultApi,
    public store: LocalStore,
  ) {
    this.vault = new VaultClient(api, store, "windows");
    this.listen();
  }

  // ---- Unlock and lock, as Platform wants them ----

  async unlock(password: string): Promise<void> {
    const r = await this.vault.unlock(password, undefined, { keepSecret: true });
    this.secret = r.secret ?? null;
    this.session = this.api.session;
    this.afterUnlock();
  }

  /** Called from VaultApp right after unlock, to open its own client on the same keys. */
  restore(): { secret: Uint8Array; session: string | null } | null {
    const secret = this.secret;
    if (!secret) return null;
    this.secret = null;
    // VaultApp copies what it needs as soon as it's handed this. Don't leave it lying around.
    setTimeout(() => secret.fill(0), 3000);
    return { secret, session: this.session };
  }

  /** The short PIN gave us the secret: this client opens on the same keys. */
  async adoptSecret(secret: Uint8Array): Promise<void> {
    await this.vault.restoreSession(secret.slice(), null);
    this.afterUnlock();
  }

  async unlockWithHello(): Promise<Uint8Array | null> {
    const secret = await native.helloUnlock();
    await this.vault.restoreSession(secret, null);
    this.afterUnlock();
    setTimeout(() => secret.fill(0), 3000);
    return secret;
  }

  async lock(): Promise<void> {
    this.stopTimers();
    this.showDeviceRequests([]);
    this.secret = null;
    await this.vault.lock();
  }

  /** From outside the vault screens: the tray, or the machine waking. Reloading the page is
   *  what wipes the screens' copy of the keys and takes them back to the lock screen. */
  async lockEverything(): Promise<void> {
    await this.lock();
    location.reload();
  }

  private stopTimers() {
    if (this.backupTimer) clearInterval(this.backupTimer);
    if (this.deviceTimer) clearInterval(this.deviceTimer);
    this.backupTimer = null;
    this.deviceTimer = null;
  }

  private afterUnlock() {
    this.stopTimers();
    this.backupTimer = setInterval(() => this.runBackup(false).catch(() => undefined), BACKUP_CHECK_MS);
    setTimeout(() => this.runBackup(false).catch(() => undefined), 30_000);
    this.deviceTimer = setInterval(() => this.checkDevices(), DEVICE_CHECK_MS);
    // A moment later: after Hello or a PIN, the screens' client is what gets the session.
    setTimeout(() => this.checkDevices(), 3000);
  }

  // ---- New devices asking to join (PLAN 3.4) ----

  private async checkDevices() {
    if (!this.vault.unlocked) return;
    try {
      const requests = await this.api.deviceRequests();
      // It may have locked while that was on its way.
      if (this.vault.unlocked) this.showDeviceRequests(requests);
    } catch {
      /* offline, or the session's being renewed: the next check will do */
    }
  }

  private showDeviceRequests(requests: DeviceRequestOut[]) {
    const isNew = requests.some((r) => !this.knownRequests.has(r.id));
    const changed = isNew || requests.length !== this.knownRequests.size;
    this.knownRequests = new Set(requests.map((r) => r.id));
    this.onDeviceRequests?.(requests);
    if (changed) native.deviceNotice(requests.length, requests[0]?.name ?? null, isNew).catch(() => undefined);
  }

  /** The screens changed the local copy: read it again, once a burst has settled. */
  notifyChanged() {
    if (this.changed) clearTimeout(this.changed);
    this.changed = setTimeout(() => {
      if (this.vault.unlocked) this.vault.reload().catch(() => undefined);
    }, 300);
  }

  // ---- Backup ----

  /** `force` is the "Back up now" button. Otherwise only when due. Needs an unlocked vault:
   *  there's nothing to encrypt until there is. Returns the file's path if it wrote one. */
  async runBackup(force: boolean): Promise<string | null> {
    if (!this.vault.unlocked) return null;
    const status = await native.backupStatus();
    if (!force && !status.due) return null;
    const password = await native.backupPasswordGet();
    if (!password) throw new Error("Set a backup password first.");
    // A fill-only vault's items stay out: this file's password is one the person knows.
    const items = this.vault.exportable().filter((i) => this.vault.canReveal(i.vaultId));
    const data = await encryptedExport(items, password);
    const path = await native.backupSave(data, stamp());
    this.api.noteExport().catch(() => undefined);
    return path;
  }

  // ---- Events from Rust ----

  private listen() {
    listen<{ req: number; q: string }>("quick:search", ({ payload }) => this.quickSearch(payload.req, payload.q));
    listen<{ token: string; id: string; action: string; confirmed: boolean }>("quick:act", ({ payload }) => this.quickAct(payload).catch((e) => this.feedback(e)));
    listen("app:lock", () => this.lockEverything());
    listen("power:resumed", async () => {
      const s = await this.store.getMeta<{ lockOnSleep?: boolean }>("settings");
      if ((s?.lockOnSleep ?? true) && this.vault.unlocked) await this.lockEverything();
    });
    listen<{ req: number }>("ssh:identities", ({ payload }) => {
      const identities = this.vault.unlocked
        ? this.vault.allItems().flatMap((i) => {
            const id = usableIdentity(i.body);
            return id ? [{ blob: toB64u(id.blob), comment: id.comment }] : [];
          })
        : [];
      invoke("ssh_identities_reply", { req: payload.req, identities });
    });
    listen<{ req: number; blob: string; data: string }>("ssh:sign", ({ payload }) => {
      let signature: string | null = null;
      if (this.vault.unlocked) {
        for (const item of this.vault.allItems()) {
          const id = usableIdentity(item.body);
          if (id && toB64u(id.blob) === payload.blob) {
            signature = toB64u(ed25519Sign(id.seed, fromB64u(payload.data)));
            id.seed.fill(0);
            break;
          }
        }
      }
      invoke("ssh_sign_reply", { req: payload.req, signature });
    });
  }

  // ---- Quick search ----

  private quickSearch(req: number, q: string) {
    touchIdleTimer();
    if (!this.vault.unlocked) {
      invoke("quick_results", { req, results: [], locked: true });
      return;
    }
    const results = this.vault
      .search(q)
      .filter((i) => !i.body.archived)
      .slice(0, 30)
      .map((i) => ({
        id: i.id,
        title: i.body.title,
        subtitle: subtitle(i),
        kind: i.body.kind,
        has_totp: !!i.body.totp?.secret,
        can_type: i.body.kind === "login",
        reprompt: !!i.body.reprompt,
      }));
    invoke("quick_results", { req, results, locked: false });
  }

  private feedback(e: unknown, close = false) {
    return invoke("quick_feedback", { close, message: e instanceof Error ? e.message : e == null ? null : String(e), mismatch: null });
  }

  private async quickAct(a: { token: string; id: string; action: string; confirmed: boolean }) {
    touchIdleTimer();
    const item = this.vault.unlocked ? this.vault.get(a.id) : undefined;
    if (!item) return this.feedback("That item isn't available.");
    const b = item.body;
    // Items marked to ask for the master password don't get a way round it here.
    if (b.reprompt && a.action !== "copy-user") {
      await native.mainShow();
      return this.feedback("This item asks for your master password, so open it in the app.");
    }
    if (a.action === "copy" || a.action === "totp") {
      // A fill-only role can use a login but not see it. Typing it is the fill path; a copy
      // would hand over the secret itself.
      if (!this.vault.canReveal(item.vaultId)) return this.feedback("You can fill from this shared vault, but not copy. Press Ctrl+Enter to type it.");
      const value = a.action === "totp" ? (b.totp ? await totpCode(b.totp) : undefined) : mainSecret(item);
      if (!value) return this.feedback(a.action === "totp" ? "This item has no 2FA code." : "This item has nothing to copy.");
      await native.copy(value, true, await clipboardSeconds(this.store));
      return this.feedback(null, true);
    }
    if (a.action === "copy-user") {
      if (!b.username) return this.feedback("This item has no username.");
      await native.copy(b.username, false);
      return this.feedback(null, true);
    }
    if (a.action === "type") {
      if (b.kind !== "login") return this.feedback("Only logins can be typed.");
      const titles = [b.title, ...(b.fields ?? []).filter((f) => f.name.trim().toLowerCase() === "window title").map((f) => f.value)];
      const r = await invoke<{ outcome: "typed"; keys: number } | { outcome: "mismatch"; window: string; item: string } | { outcome: "failed"; message: string }>("autotype_perform", {
        token: a.token,
        titles,
        username: b.username ?? "",
        password: b.password ?? "",
        confirmed: a.confirmed,
      });
      if (r.outcome === "mismatch") return invoke("quick_feedback", { close: false, message: null, mismatch: { window: r.window, item: r.item } });
      if (r.outcome === "failed") return this.feedback(r.message);
    }
  }
}
