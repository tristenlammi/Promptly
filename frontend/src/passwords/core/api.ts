// The vault's HTTP API, with no browser assumptions beyond fetch. The web page
// passes its bearer token; the extension, desktop and tests pass a device token.

export type AuthProvider = () => Promise<string | null> | string | null;

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: unknown,
    public retryAfter?: number,
  ) {
    super(typeof detail === "string" ? detail : `Request failed (${status})`);
  }
}

/** The server couldn't be reached at all, which clients treat as "work offline". */
export class OfflineError extends Error {
  constructor() {
    super("The server can't be reached");
  }
}

export type Kdf = { alg: "argon2id"; m: number; t: number; p: number };
export type Prelogin = {
  user_id: string;
  exists: boolean;
  account_id: string | null;
  kdf: Kdf | null;
  salt: string | null;
  min_kdf: Kdf;
  /** Checked here, before anything derived from the password is sent. */
  wrapped_keyset?: string | null;
  preview: boolean;
  enabled: boolean;
  server_time: string;
};
export type SessionOut = {
  token: string;
  expires_at: string;
  account_id: string;
  wrapped_keyset: string;
  kdf: Kdf;
  salt: string;
  x25519_pub: string;
  ed25519_pub: string;
  kit_confirmed: boolean;
  kit_checked_at: string | null;
  user_id: string;
};
export type Grant = { wrapped_key: string; signature: string };
export type VaultOut = {
  id: string;
  kind: "personal" | "shared";
  revision: number;
  generation: number;
  name: string;
  role: "manage" | "edit" | "view" | "fill";
  wrapped_key: string;
  signature: string;
  granted_by: string | null;
  member_generation: number;
  accepted: boolean;
  rotate_needed?: boolean;
  member_count: number;
};
export type ItemOut = { id: string; revision: number; blob: string | null; deleted: boolean; purged: boolean; updated_at: string };
export type ChangesOut = { revision: number; generation: number; items: ItemOut[]; more: boolean };
export type ItemWrite = { id: string; base_revision?: number; blob?: string | null; deleted?: boolean; purge?: boolean };
export type BatchOut = {
  revision: number;
  applied: string[];
  conflicts: { id: string; reason: string; revision?: number | null; blob?: string | null; deleted?: boolean }[];
};
export type MemberOut = {
  user_id: string;
  username: string;
  role: VaultOut["role"];
  granted_by: string | null;
  generation: number;
  accepted: boolean;
  x25519_pub: string | null;
  ed25519_pub: string | null;
};
export type DeviceOut = {
  id: string;
  name: string;
  platform: string;
  scopes: string[];
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
  current: boolean;
};
export type DeviceRequestOut = {
  id: string;
  name: string;
  platform: string;
  code: string;
  device_pub: string;
  approver_pub: string | null;
  status: string;
  created_at: string;
  expires_at: string;
};
export type ActivityOut = { event: string; device_id: string | null; at: string };

const JSON_HEADERS = { "Content-Type": "application/json" };

export class VaultApi {
  session: string | null = null;

  constructor(
    public baseUrl: string,
    public auth: AuthProvider,
    private fetcher: typeof fetch = (...a) => fetch(...a),
  ) {}

  async request<T>(method: string, path: string, body?: unknown, opts: { public?: boolean; raw?: BodyInit; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (body !== undefined) Object.assign(headers, JSON_HEADERS);
    if (!opts.public) {
      const token = await this.auth();
      if (token) headers.Authorization = `Bearer ${token}`;
      if (this.session) headers["X-Vault-Session"] = this.session;
    }
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}/api/passwords${path}`, {
        method,
        headers,
        body: opts.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        // No cookies: identity is an explicit header, so a page can't ride along.
        credentials: "omit",
        // Never the HTTP cache: nothing from this API belongs on disk unencrypted,
        // and blobs must never be replayed from a stale copy.
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new OfflineError();
    }
    if (res.status === 204) return undefined as T;
    if (!res.ok) {
      let detail: unknown = res.statusText;
      try {
        detail = ((await res.json()) as { detail?: unknown }).detail ?? detail;
      } catch {
        /* not JSON: keep the status text */
      }
      const retry = Number(res.headers.get("Retry-After"));
      throw new ApiError(res.status, detail, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    const type = res.headers.get("Content-Type") ?? "";
    if (type.includes("application/json")) return (await res.json()) as T;
    return (await res.arrayBuffer()) as T;
  }

  prelogin = () => this.request<Prelogin>("GET", "/account");
  createAccount = (body: unknown) => this.request<SessionOut>("POST", "/account", body);
  createSession = (auth_key: string) => this.request<SessionOut>("POST", "/session", { auth_key });
  endSession = () => this.request<void>("DELETE", "/session");
  rekey = (body: unknown) => this.request<void>("POST", "/account/rekey", body);
  confirmKit = () => this.request<void>("POST", "/account/kit");
  reset = (body: unknown) => this.request<void>("POST", "/account/reset", body);

  vaults = () => this.request<VaultOut[]>("GET", "/vaults");
  createVault = (body: { id: string; name: string; grant: Grant }) => this.request<VaultOut>("POST", "/vaults", body);
  renameVault = (id: string, name: string) => this.request<void>("PATCH", `/vaults/${id}`, { name });
  deleteVault = (id: string) => this.request<void>("DELETE", `/vaults/${id}`);
  acceptVault = (id: string) => this.request<void>("POST", `/vaults/${id}/accept`);
  leaveVault = (id: string) => this.request<void>("POST", `/vaults/${id}/leave`);
  changes = (id: string, since: number, limit = 500) => this.request<ChangesOut>("GET", `/vaults/${id}/changes?since=${since}&limit=${limit}`);
  writeItems = (id: string, items: ItemWrite[], generation?: number) => this.request<BatchOut>("POST", `/vaults/${id}/items`, { items, generation });
  versions = (vaultId: string, itemId: string) =>
    this.request<{ revision: number; blob: string; created_at: string }[]>("GET", `/vaults/${vaultId}/items/${itemId}/versions`);

  members = (id: string) => this.request<MemberOut[]>("GET", `/vaults/${id}/members`);
  addMember = (id: string, body: { user_id: string; role: string; grant: Grant }) => this.request<void>("POST", `/vaults/${id}/members`, body);
  removeMember = (id: string, userId: string) => this.request<void>("DELETE", `/vaults/${id}/members/${userId}`);
  setRole = (id: string, userId: string, role: string) => this.request<void>("PATCH", `/vaults/${id}/members/${userId}`, { role });
  rotate = (id: string, body: unknown) => this.request<void>("POST", `/vaults/${id}/rotate`, body);
  userKeys = (userId: string) => this.request<{ user_id: string; username: string; x25519_pub: string; ed25519_pub: string }>("GET", `/users/${userId}/keys`);

  devices = () => this.request<DeviceOut[]>("GET", "/devices");
  revokeDevice = (id: string) => this.request<void>("DELETE", `/devices/${id}`);
  connectStart = (name: string, platform: string, scopes = ["vault"]) =>
    this.request<{ id: string; code: string; poll_secret: string; expires_at: string }>("POST", "/connect/start", { name, platform, scopes }, { public: true });
  connectPoll = (id: string, poll_secret: string) =>
    this.request<{ status: string; token: string | null; device_id: string | null; user_id: string | null }>("POST", "/connect/poll", { id, poll_secret }, { public: true });
  connectInfo = (code: string) => this.request<{ name: string; platform: string; scopes: string[]; status: string }>("GET", `/connect/code/${code}`);
  connectApprove = (code: string) => this.request<void>("POST", `/connect/code/${code}/approve`);
  connectDeny = (code: string) => this.request<void>("POST", `/connect/code/${code}/deny`);

  deviceRequestCreate = (name: string, platform: string, device_pub: string) =>
    this.request<{ id: string; code: string; poll_secret: string; expires_at: string }>("POST", "/device-requests", { name, platform, device_pub });
  deviceRequests = () => this.request<DeviceRequestOut[]>("GET", "/device-requests");
  deviceRequestApprover = (id: string, approver_pub: string) => this.request<void>("POST", `/device-requests/${id}/approver`, { approver_pub });
  deviceRequestApprove = (id: string, payload: string) => this.request<void>("POST", `/device-requests/${id}/approve`, { payload });
  deviceRequestDeny = (id: string) => this.request<void>("POST", `/device-requests/${id}/deny`);
  deviceRequestPoll = (id: string, poll_secret: string) =>
    this.request<{ status: string; approver_pub: string | null; payload: string | null }>("POST", `/device-requests/${id}/poll`, { poll_secret });

  attachmentStart = (vaultId: string, body: { id: string; item_id: string; chunk_count: number }) =>
    this.request<{ id: string; item_id: string; chunk_count: number; size_bytes: number; complete: boolean; received: number[] }>("POST", `/vaults/${vaultId}/attachments`, body);
  attachmentPut = (vaultId: string, id: string, index: number, blob: Uint8Array) =>
    this.request<void>("PUT", `/vaults/${vaultId}/attachments/${id}/chunks/${index}`, undefined, { raw: blob as Uint8Array<ArrayBuffer>, headers: { "Content-Type": "application/octet-stream" } });
  attachmentFinish = (vaultId: string, id: string) => this.request<unknown>("POST", `/vaults/${vaultId}/attachments/${id}/finish`);
  attachmentGet = (vaultId: string, id: string, index: number) => this.request<ArrayBuffer>("GET", `/vaults/${vaultId}/attachments/${id}/chunks/${index}`);
  attachmentDelete = (vaultId: string, id: string) => this.request<void>("DELETE", `/vaults/${vaultId}/attachments/${id}`);

  breachRange = async (prefix: string): Promise<string> => {
    const raw = await this.request<ArrayBuffer>("POST", "/breach/range", { prefix });
    return new TextDecoder().decode(raw);
  };
  directory = () => this.request<{ twofa: Record<string, { documentation?: string }>; passkeys: Record<string, unknown> }>("GET", "/directory");
  icon = (domain: string) => this.request<ArrayBuffer>("POST", "/icon", { domain });

  activity = (limit = 100) => this.request<ActivityOut[]>("GET", `/activity?limit=${limit}`);
  noteExport = () => this.request<void>("POST", "/activity/export");
  putHealth = (counts: { weak: number; reused: number; breached: number; old: number }) => this.request<void>("PUT", "/health", counts);
  deleteHealth = () => this.request<void>("DELETE", "/health");
}
