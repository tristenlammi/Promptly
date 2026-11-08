/**
 * The LiveKit client, loaded on demand (its own chunk, kept out of the PWA
 * precache) so nobody downloads it until they use voice or Test calls.
 * Shared by Calls and, later, Talking to Promptly.
 */
export type LiveKit = typeof import("livekit-client");

let loading: Promise<LiveKit> | null = null;

export function loadLiveKit(): Promise<LiveKit> {
  if (!loading) {
    loading = import("livekit-client").catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** ``/livekit`` (same origin, through nginx) as a WebSocket URL. */
export function signalUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

/** Browsers that can choose where audio plays (``setSinkId``). */
export function canChooseSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

export interface ConnectionInfo {
  protocol: "udp" | "tcp" | null;
  candidateType: "host" | "srflx" | "prflx" | "relay" | null;
  /** The calls server's address as this browser reached it. */
  serverAddress: string | null;
  rttMs: number | null;
}

type StatsLike = { forEach(cb: (s: Record<string, unknown>) => void): void; get?(id: string): unknown };

/** The ICE pair a peer connection (or sender/receiver) is using. */
export function connectionFromStats(report: StatsLike | undefined | null): ConnectionInfo {
  const empty: ConnectionInfo = { protocol: null, candidateType: null, serverAddress: null, rttMs: null };
  if (!report) return empty;
  const byId = new Map<string, Record<string, unknown>>();
  report.forEach((s) => byId.set(String(s.id), s));
  let pair: Record<string, unknown> | undefined;
  byId.forEach((s) => {
    if (s.type === "transport" && s.selectedCandidatePairId) pair = byId.get(String(s.selectedCandidatePairId));
  });
  if (!pair) {
    byId.forEach((s) => {
      if (!pair && s.type === "candidate-pair" && s.state === "succeeded" && (s.nominated || s.selected)) pair = s;
    });
  }
  if (!pair) return empty;
  const local = byId.get(String(pair.localCandidateId));
  const remote = byId.get(String(pair.remoteCandidateId));
  const proto = String((local?.protocol ?? remote?.protocol ?? "") as string).toLowerCase();
  const ltype = String(local?.candidateType ?? "");
  const rtype = String(remote?.candidateType ?? "");
  const relay = ltype === "relay" || rtype === "relay";
  const address = (remote?.address ?? remote?.ip ?? null) as string | null;
  const rtt = typeof pair.currentRoundTripTime === "number" ? Math.round((pair.currentRoundTripTime as number) * 1000) : null;
  return {
    protocol: proto === "udp" || proto === "tcp" ? proto : null,
    candidateType: relay ? "relay" : ((["host", "srflx", "prflx"].includes(rtype) ? rtype : null) as ConnectionInfo["candidateType"]),
    serverAddress: address && /^[0-9a-f.:]+$/i.test(address) ? address : null,
    rttMs: rtt,
  };
}

/** Plain words for how a connection got through. */
export function connectionWords(info: Pick<ConnectionInfo, "protocol" | "candidateType"> | null): {
  title: string;
  hint: string;
} {
  if (!info || !info.protocol) return { title: "Connected", hint: "" };
  if (info.candidateType === "relay") return { title: "Through a relay", hint: "Works, with a little more delay." };
  if (info.protocol === "tcp")
    return {
      title: "Fallback over TCP (fine)",
      hint: "Sound gets through, but UDP is blocked on the way. Speech can lag a little on a busy network.",
    };
  return { title: "Direct (best)", hint: "Sound goes straight to the calls server over UDP." };
}
