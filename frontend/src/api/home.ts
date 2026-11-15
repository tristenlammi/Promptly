import { apiClient } from "@/api/client";

/**
 * Promptly Home: the devices in your home, through the box that lives there
 * (backend ``app/home``). Everything is under ``/api/home`` and is a 404
 * until an admin turns Home on. A home's devices are only ever its members'.
 */

export type HomeRole = "owner" | "adult" | "guest";

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
}

export interface HomeBox {
  id: string;
  name: string;
  online: boolean;
  last_seen_at: string | null;
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
  state: (homeId: string, after: number) => apiClient.get<HomeState>(`/home/${homeId}/state`, { params: { after } }).then((r) => r.data),
  claim: (body: { code: string; home_id?: string; home_name?: string }) =>
    apiClient.post<{ home_id: string; box_id: string; online: boolean }>("/home/claim", body).then((r) => r.data),
  act: (homeId: string, body: { box_id: string; entity_id: string; action: "turn_on" | "turn_off" | "toggle" }) =>
    apiClient.post(`/home/${homeId}/act`, body).then(() => undefined),
  rename: (homeId: string, name: string) => apiClient.patch(`/home/${homeId}`, { name }).then(() => undefined),
  addMember: (homeId: string, username: string, role: "adult" | "guest") =>
    apiClient.post(`/home/${homeId}/members`, { username, role }).then(() => undefined),
  removeMember: (homeId: string, userId: string) => apiClient.delete(`/home/${homeId}/members/${userId}`).then(() => undefined),
  releaseBox: (homeId: string, boxId: string) =>
    apiClient.delete<{ claim_code: string }>(`/home/${homeId}/boxes/${boxId}`).then((r) => r.data.claim_code),
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
  settings: () => apiClient.get<{ enabled: boolean }>("/admin/home/settings").then((r) => r.data),
  setEnabled: (enabled: boolean) => apiClient.patch<{ enabled: boolean }>("/admin/home/settings", { enabled }).then((r) => r.data),
  boxes: () => apiClient.get<{ boxes: AdminBox[] }>("/admin/home/boxes").then((r) => r.data.boxes),
  prepare: (label: string, server_url: string) => apiClient.post<PreparedBox>("/admin/home/boxes", { label, server_url }).then((r) => r.data),
  newCode: (id: string) => apiClient.post<{ claim_code: string; claim_url: string }>(`/admin/home/boxes/${id}/claim-code`).then((r) => r.data),
  newSetup: (id: string, server_url: string) =>
    apiClient.post<{ setup: string; server: string }>(`/admin/home/boxes/${id}/setup`, { server_url }).then((r) => r.data.setup),
  revoke: (id: string, revoked: boolean) => apiClient.post(`/admin/home/boxes/${id}/revoke`, { revoked }).then(() => undefined),
  remove: (id: string) => apiClient.delete(`/admin/home/boxes/${id}`).then(() => undefined),
};
