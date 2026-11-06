// Talking to the Rust side.
import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";

/** Rust's errors arrive as plain strings. The screens expect Error objects to read a message from. */
async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args, options);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
}

function b64uJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Stands in for `fetch` in VaultApi. This page has no network of its own (see the CSP): every
 *  request goes through Rust, which allows only the connected server's vault API. */
export const nativeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers: [string, string][] = [];
  new Headers(init?.headers).forEach((v, k) => headers.push([k, v]));
  const meta = b64uJson({ url, method: init?.method ?? "GET", headers });
  let body: Uint8Array;
  const raw = init?.body;
  if (raw == null) body = new Uint8Array(0);
  else if (typeof raw === "string") body = new TextEncoder().encode(raw);
  else if (raw instanceof Uint8Array) body = raw;
  else if (raw instanceof ArrayBuffer) body = new Uint8Array(raw);
  else throw new Error("Unsupported request body");
  const framed = new Uint8Array(await invoke<ArrayBuffer>("net_fetch", body, { headers: { "x-meta": meta } }));
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  const headLen = view.getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + headLen))) as { status: number; headers: [string, string][] };
  const content = framed.slice(4 + headLen);
  const noBody = head.status === 204 || head.status === 205 || head.status === 304;
  return new Response(noBody ? null : content, { status: head.status, headers: head.headers });
};

export type Connection = { server: string; device_id: string | null; user_id: string | null };

export const native = {
  connectionGet: () => invoke<Connection | null>("connection_get"),
  connectionBegin: (server: string) => invoke<string>("connection_begin", { server }),
  connectionSave: (token: string, deviceId: string, userId: string) => invoke<void>("connection_save", { token, deviceId, userId }),
  connectionClear: () => invoke<void>("connection_clear"),
  deviceName: () => invoke<string>("device_name"),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  copy: (text: string, sensitive: boolean, seconds?: number) => invoke<void>("clipboard_copy", { text, sensitive, seconds }),
  clearClipboard: () => invoke<boolean>("clipboard_clear"),
  helloStatus: () => invoke<{ available: boolean; enabled: boolean }>("hello_status"),
  helloEnable: (secret: Uint8Array) => invoke<void>("hello_enable", secret),
  helloUnlock: async () => new Uint8Array(await invoke<ArrayBuffer>("hello_unlock")),
  helloDisable: () => invoke<void>("hello_disable"),
  autostartGet: () => invoke<boolean>("autostart_get"),
  autostartSet: (on: boolean) => invoke<void>("autostart_set", { on }),
  backupStatus: () => invoke<BackupStatus>("backup_status"),
  backupConfigure: (enabled: boolean, dir: string, everyHours: number, keep: number) => invoke<void>("backup_configure", { enabled, dir, everyHours, keep }),
  backupSave: (data: string, stamp: string) => invoke<string>("backup_save", { data, stamp }),
  backupPasswordSet: (password: string) => invoke<void>("backup_password_set", { password }),
  backupPasswordGet: () => invoke<string | null>("backup_password_get"),
  nativeHostStatus: () => invoke<{ extension_ids: string[]; firefox_id: string }>("native_host_status"),
  nativeHostSet: (on: boolean, extensionIds: string[]) => invoke<void>("native_host_set", { on, extensionIds }),
  sshStatus: () => invoke<SshStatus>("ssh_status"),
  sshSet: (on: boolean) => invoke<SshStatus>("ssh_set", { on }),
  updaterStatus: () => invoke<boolean>("updater_status"),
  mainShow: () => invoke<void>("main_show"),
  deviceNotice: (count: number, name: string | null, isNew: boolean) => invoke<void>("device_notice", { count, name, isNew }),
};

export type BackupStatus = { enabled: boolean; dir: string; every_hours: number; keep: number; last_run_ms: number; last_error: string | null; has_password: boolean; due: boolean; default_dir: string };
export type SshStatus = { enabled: boolean; running: boolean; error: string | null };
