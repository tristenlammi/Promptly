import { apiClient } from "@/api/client";

/**
 * Promptly Home: the devices in your home, through the box that lives there
 * (backend ``app/home``). Everything is under ``/api/home`` and is a 404
 * until an admin turns Home on. A home's devices are only ever its members'.
 */

export type HomeRole = "owner" | "member";

export interface HomeEntity {
  id: string;
  box_id: string;
  domain: string;
  name: string;
  state: string;
  /** Area id (see ``areas``). */
  area?: string;
  unit?: string;
  /** Home Assistant's device class: temperature, motion, door… */
  cls?: string;
  /** Brightness, 0–100, for a light that's on. */
  bri?: number;
  /** Its box is connected right now. */
  online: boolean;
  can_switch: boolean;
  /** A lock, or a garage door or gate: ask "are you sure?" before letting someone in. */
  careful: boolean;
  /** What its controls need beyond on and off. */
  x?: {
    /** Light: colour modes it supports; climate: its modes. */
    modes?: string[];
    /** Light warmth in kelvin, and its range. */
    k?: number;
    kmin?: number;
    kmax?: number;
    rgb?: [number, number, number];
    /** Fan speed, 0–100. */
    pct?: number;
    /** Cover position, 0 (closed) – 100 (open). */
    pos?: number;
    /** Climate: target and current temperature, range and step. */
    target?: number;
    cur?: number;
    min?: number;
    max?: number;
    step?: number;
    /** Media: volume 0–100, what's playing. */
    vol?: number;
    title?: string;
    muted?: boolean;
  };
}

export type HomeAction =
  | "turn_on" | "turn_off" | "toggle" | "set" | "speed" | "open" | "close" | "stop" | "position"
  | "temperature" | "mode" | "play" | "pause" | "volume" | "lock" | "unlock";

/** One field of a set-up step. */
export interface SetupField {
  name: string;
  label: string;
  hint?: string;
  required: boolean;
  type: "text" | "password" | "number" | "bool" | "select" | "multiselect" | "unsupported";
  default?: string | number | boolean | string[];
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
}

/** One step of adding a device, as the box describes it. */
export type SetupStep = { flow: string; brand: string; brand_name: string; step?: string } & (
  | { kind: "form"; title: string; text?: string; fields: SetupField[]; errors: Record<string, string>; last: boolean }
  | { kind: "menu"; title: string; text?: string; options: { value: string; label: string }[] }
  | { kind: "wait"; text: string }
  | { kind: "done"; title: string; entry_id?: string; devices?: { device_id: string; name: string; area: string }[] }
  | { kind: "stopped"; reason: string; text: string }
  | { kind: "elsewhere"; text: string }
);

export interface FoundDevice {
  flow: string;
  brand: string;
  brand_name: string;
  name: string;
}

export interface Brand {
  id: string;
  name: string;
  note: string;
  /** Works through its maker's cloud, not only inside your home. */
  cloud: boolean;
  featured: boolean;
}

export interface Connected {
  id: string;
  brand: string;
  brand_name: string;
  title: string;
  state: string;
}

export interface HomeBox {
  id: string;
  name: string;
  online: boolean;
  last_seen_at: string | null;
  version: string | null;
  added_at: string | null;
  /** This server's own box: nothing to plug in, and it can't be moved. */
  builtin: boolean;
  /** It has said what devices it has (a fresh one takes a minute or two). */
  ready: boolean;
}

export interface HomeDevices {
  rev: number;
  boxes: HomeBox[];
  areas: { id: string; name: string }[];
  entities: HomeEntity[];
}

export interface Home extends HomeDevices {
  id: string;
  name: string;
  role: HomeRole;
  members: { id: string; name: string; username: string; role: HomeRole }[];
}

export type HomeState = ({ changed: true } & HomeDevices) | { changed: false; rev: number };

export const homeApi = {
  available: () => apiClient.get<{ available: boolean }>("/home/available").then((r) => r.data.available === true).catch(() => false),
  homes: () => apiClient.get<{ homes: Home[] }>("/home").then((r) => r.data.homes),
  /** This server has its own home box (bundled with Promptly): nothing to plug in. */
  bundled: () => apiClient.get<{ bundled: boolean }>("/home").then((r) => r.data.bundled === true).catch(() => false),
  state: (homeId: string, after: number) => apiClient.get<HomeState>(`/home/${homeId}/state`, { params: { after } }).then((r) => r.data),
  claim: (body: { code: string; home_id?: string; home_name?: string }) =>
    apiClient.post<{ home_id: string; box_id: string; online: boolean }>("/home/claim", body).then((r) => r.data),
  act: (homeId: string, body: { box_id: string; entity_id: string; action: HomeAction; value?: unknown; confirm?: boolean }) =>
    apiClient.post(`/home/${homeId}/act`, body).then(() => undefined),
  rename: (homeId: string, name: string) => apiClient.patch(`/home/${homeId}`, { name }).then(() => undefined),
  addMember: (homeId: string, username: string) => apiClient.post(`/home/${homeId}/members`, { username }).then(() => undefined),
  removeMember: (homeId: string, userId: string) => apiClient.delete(`/home/${homeId}/members/${userId}`).then(() => undefined),
  releaseBox: (homeId: string, boxId: string) =>
    apiClient.delete<{ claim_code: string }>(`/home/${homeId}/boxes/${boxId}`).then((r) => r.data.claim_code),

  // ---- adding devices, rooms (each goes to the home's box and back) ----
  found: (h: string, b: string) => apiClient.get<{ found: FoundDevice[] }>(`/home/${h}/boxes/${b}/setup/found`).then((r) => r.data.found),
  brands: (h: string, b: string, q: string) => apiClient.get<{ brands: Brand[] }>(`/home/${h}/boxes/${b}/setup/brands`, { params: { q } }).then((r) => r.data.brands),
  setupStart: (h: string, b: string, brand: string) => apiClient.post<SetupStep>(`/home/${h}/boxes/${b}/setup`, { brand }).then((r) => r.data),
  setupGet: (h: string, b: string, flow: string) => apiClient.get<SetupStep>(`/home/${h}/boxes/${b}/setup/${flow}`).then((r) => r.data),
  /** What was typed goes straight through to the box; the server keeps none of it. */
  setupStep: (h: string, b: string, flow: string, input: Record<string, unknown>) =>
    apiClient.post<SetupStep>(`/home/${h}/boxes/${b}/setup/${flow}`, { input }).then((r) => r.data),
  setupAbort: (h: string, b: string, flow: string) => apiClient.delete(`/home/${h}/boxes/${b}/setup/${flow}`).then(() => undefined).catch(() => undefined),
  connected: (h: string, b: string) => apiClient.get<{ connected: Connected[] }>(`/home/${h}/boxes/${b}/connected`).then((r) => r.data.connected),
  disconnect: (h: string, b: string, id: string) => apiClient.delete(`/home/${h}/boxes/${b}/connected/${id}`).then(() => undefined),
  addRoom: (h: string, b: string, name: string) => apiClient.post<{ id: string; name: string }>(`/home/${h}/boxes/${b}/rooms`, { name }).then((r) => r.data),
  renameRoom: (h: string, b: string, area: string, name: string) => apiClient.patch(`/home/${h}/boxes/${b}/rooms/${area}`, { name }).then(() => undefined),
  deleteRoom: (h: string, b: string, area: string) => apiClient.delete(`/home/${h}/boxes/${b}/rooms/${area}`).then(() => undefined),
  updateDevice: (h: string, b: string, body: { device_id?: string; entity_id?: string; name?: string; area?: string }) =>
    apiClient.patch(`/home/${h}/boxes/${b}/devices`, body).then(() => undefined),
  renameBox: (h: string, b: string, name: string) => apiClient.patch(`/home/${h}/boxes/${b}`, { name }).then(() => undefined),
};

// ---- Admin → Home ----

export interface AdminBox {
  id: string;
  label: string;
  claimed: boolean;
  has_code: boolean;
  online: boolean;
  revoked: boolean;
  last_seen_at: string | null;
  version: string | null;
  created_at: string | null;
}

export interface AdminHomeSettings {
  enabled: boolean;
  /** Home Assistant is bundled with this server. */
  bundled: boolean;
  /** This server's own box has connected, and has said what devices it has. */
  box_online: boolean;
  box_ready: boolean;
}

export interface PreparedBox {
  box: AdminBox;
  /** Goes into the box. Shown once. */
  setup: string;
  /** The address the box will dial (it's inside the setup string). */
  server: string;
  /** Goes on the card. Shown once. */
  claim_code: string;
  claim_url: string;
}

export const homeAdminApi = {
  settings: () => apiClient.get<AdminHomeSettings>("/admin/home/settings").then((r) => r.data),
  setEnabled: (enabled: boolean) => apiClient.patch<AdminHomeSettings>("/admin/home/settings", { enabled }).then((r) => r.data),
  boxes: () => apiClient.get<{ boxes: AdminBox[] }>("/admin/home/boxes").then((r) => r.data.boxes),
  prepare: (label: string, server_url: string) => apiClient.post<PreparedBox>("/admin/home/boxes", { label, server_url }).then((r) => r.data),
  newCode: (id: string) => apiClient.post<{ claim_code: string; claim_url: string }>(`/admin/home/boxes/${id}/claim-code`).then((r) => r.data),
  newSetup: (id: string, server_url: string) =>
    apiClient.post<{ setup: string; server: string }>(`/admin/home/boxes/${id}/setup`, { server_url }).then((r) => r.data.setup),
  revoke: (id: string, revoked: boolean) => apiClient.post(`/admin/home/boxes/${id}/revoke`, { revoked }).then(() => undefined),
  remove: (id: string) => apiClient.delete(`/admin/home/boxes/${id}`).then(() => undefined),
};
