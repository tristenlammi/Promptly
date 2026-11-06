// Runs in the page's own world, the only place navigator.credentials can be wrapped.
// The page can tamper with anything here, so this file decides nothing: every trust
// decision (origin, RP ID, Permissions-Policy, who's asking) is taken in the isolated
// world and the background. All this does is carry the request and shape the answer.
// The native API stays available as the fallback, and a request we can't carry always
// ends up there rather than hanging.
(() => {
  const w = window as unknown as { __promptlyPk?: boolean };
  if (w.__promptlyPk) return;
  w.__promptlyPk = true;
  if (!navigator.credentials || typeof PublicKeyCredential === "undefined") return;

  const native = {
    create: navigator.credentials.create.bind(navigator.credentials),
    get: navigator.credentials.get.bind(navigator.credentials),
  };
  const origPost = window.postMessage.bind(window);
  // The bridge answers straight away if it's there. It may not be: on-click mode, a page
  // that loaded before the mode changed, an extension that's been updated or removed.
  const ACK_MS = 750;
  // Longer than browsers keep their own WebAuthn prompts up.
  const ANSWER_MS = 6 * 60 * 1000;

  const b64u = (b: ArrayBuffer | ArrayBufferView): string => {
    const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    let s = "";
    for (const x of u) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const unb64u = (s: string): ArrayBuffer => {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };

  let seq = 0;
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data as { __pk?: string; id?: number };
    if ((d?.__pk !== "res" && d?.__pk !== "ack") || typeof d.id !== "number") return;
    waiting.get(d.id)?.(d as Record<string, unknown>);
  });

  function ask(op: "get" | "create", options: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        waiting.delete(id);
      };
      const goNative = () => {
        finish();
        origPost({ __pk: "cancel", id }, location.origin);
        resolve({ ok: false, native: true });
      };
      signal?.addEventListener("abort", () => {
        finish();
        origPost({ __pk: "cancel", id }, location.origin);
        reject(new DOMException("Aborted", "AbortError"));
      });
      timer = setTimeout(goNative, ACK_MS);
      waiting.set(id, (m) => {
        if (m.__pk === "ack") {
          clearTimeout(timer);
          timer = setTimeout(goNative, ANSWER_MS);
          return;
        }
        finish();
        resolve(m);
      });
      origPost({ __pk: "req", id, op, options }, location.origin);
    });
  }

  function failure(res: Record<string, unknown>): DOMException {
    return new DOMException(String(res.message ?? "The request wasn't allowed."), String(res.name ?? "NotAllowedError"));
  }

  function makeCredential(id: string, response: object, attachment = "platform") {
    const rawId = unb64u(id);
    const cred = Object.create(PublicKeyCredential.prototype);
    const results = {};
    for (const [k, v] of Object.entries({ id, rawId, type: "public-key", response, authenticatorAttachment: attachment })) {
      Object.defineProperty(cred, k, { value: v, enumerable: true });
    }
    Object.defineProperty(cred, "getClientExtensionResults", { value: () => results });
    Object.defineProperty(cred, "toJSON", {
      value: () => ({ id, rawId: id, type: "public-key", authenticatorAttachment: attachment, clientExtensionResults: results, response: (response as { toJSON?: () => unknown }).toJSON?.() }),
    });
    return cred as PublicKeyCredential;
  }

  function attestation(r: Record<string, string>) {
    const obj = Object.create(AuthenticatorAttestationResponse.prototype);
    const clientDataJSON = unb64u(r.clientDataJSON);
    const attestationObject = unb64u(r.attestationObject);
    for (const [k, v] of Object.entries({ clientDataJSON, attestationObject })) Object.defineProperty(obj, k, { value: v, enumerable: true });
    Object.defineProperty(obj, "getAuthenticatorData", { value: () => unb64u(r.authenticatorData) });
    Object.defineProperty(obj, "getPublicKey", { value: () => unb64u(r.publicKey) });
    Object.defineProperty(obj, "getPublicKeyAlgorithm", { value: () => Number(r.publicKeyAlgorithm) });
    Object.defineProperty(obj, "getTransports", { value: () => ["internal"] });
    Object.defineProperty(obj, "toJSON", {
      value: () => ({ clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, authenticatorData: r.authenticatorData, publicKey: r.publicKey, publicKeyAlgorithm: Number(r.publicKeyAlgorithm), transports: ["internal"] }),
    });
    return obj;
  }

  function assertion(r: Record<string, string>) {
    const obj = Object.create(AuthenticatorAssertionResponse.prototype);
    const vals: Record<string, unknown> = {
      clientDataJSON: unb64u(r.clientDataJSON),
      authenticatorData: unb64u(r.authenticatorData),
      signature: unb64u(r.signature),
      userHandle: r.userHandle ? unb64u(r.userHandle) : null,
    };
    for (const [k, v] of Object.entries(vals)) Object.defineProperty(obj, k, { value: v, enumerable: true });
    Object.defineProperty(obj, "toJSON", { value: () => ({ clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle ?? null }) });
    return obj;
  }

  const list = (l?: readonly PublicKeyCredentialDescriptor[]) => (l ?? []).map((c) => ({ id: b64u(c.id as ArrayBuffer), type: c.type }));

  navigator.credentials.create = async function (options?: CredentialCreationOptions) {
    const pk = options?.publicKey;
    if (!pk) return native.create(options);
    const req = {
      rp: { id: pk.rp.id, name: pk.rp.name },
      user: { id: b64u(pk.user.id as ArrayBuffer), name: pk.user.name, displayName: pk.user.displayName },
      challenge: b64u(pk.challenge as ArrayBuffer),
      algs: (pk.pubKeyCredParams ?? []).map((p) => p.alg),
      exclude: list(pk.excludeCredentials),
      residentKey: pk.authenticatorSelection?.residentKey ?? (pk.authenticatorSelection?.requireResidentKey ? "required" : "discouraged"),
      userVerification: pk.authenticatorSelection?.userVerification ?? "preferred",
      attachment: pk.authenticatorSelection?.authenticatorAttachment,
      hasExtensions: !!pk.extensions && Object.keys(pk.extensions).length > 0,
    };
    const res = await ask("create", req, options?.signal ?? undefined);
    if (res.native) return native.create(options);
    if (!res.ok) throw failure(res);
    const r = res.result as Record<string, string>;
    return makeCredential(r.credentialId, attestation(r));
  } as typeof navigator.credentials.create;

  navigator.credentials.get = async function (options?: CredentialRequestOptions) {
    const pk = options?.publicKey;
    // The browser's own autofill UI handles conditional requests, and anything not ours.
    if (!pk || (options as { mediation?: string })?.mediation === "conditional") return native.get(options);
    const req = {
      rpId: pk.rpId,
      challenge: b64u(pk.challenge as ArrayBuffer),
      allow: list(pk.allowCredentials),
      userVerification: pk.userVerification ?? "preferred",
    };
    const res = await ask("get", req, options?.signal ?? undefined);
    if (res.native) return native.get(options);
    if (!res.ok) throw failure(res);
    const r = res.result as Record<string, string>;
    return makeCredential(r.credentialId, assertion(r));
  } as typeof navigator.credentials.get;
})();
