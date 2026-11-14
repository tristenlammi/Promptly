import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
vi.mock("./actions", () => ({
  sendMessage: vi.fn(async (_qc: unknown, _roomId: string, p: { client_id: string }) => {
    sent.push(p.client_id);
  }),
}));

import { OUTBOX_PREFIX, outboxDiff, readOutbox, startOutbox } from "./outbox";
import { useRoomsStore, type PendingMessage } from "./store";

const box = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => box.get(k) ?? null,
  setItem: (k: string, v: string) => void box.set(k, v),
  removeItem: (k: string) => void box.delete(k),
});

const ME = "me-1";
const msg = (id: string, over: Partial<PendingMessage> = {}): PendingMessage => ({
  client_id: id,
  room_id: "room-1",
  body: `hello ${id}`,
  reply_to_id: null,
  attachments: [],
  status: "sending",
  created_at: new Date().toISOString(),
  ...over,
});
const waiting = () => Object.values(useRoomsStore.getState().pending).flat();
const qc = {} as never;

beforeEach(() => {
  box.clear();
  sent.length = 0;
  useRoomsStore.setState({ pending: {} });
});

describe("messages still waiting to send", () => {
  it("are saved as they're sent and forgotten once they arrive", () => {
    const stop = startOutbox(ME, qc);
    useRoomsStore.getState().addPending(msg("a"));
    useRoomsStore.getState().addPending(msg("b"));
    expect(readOutbox(ME).map((p) => p.client_id)).toEqual(["a", "b"]);
    useRoomsStore.getState().removePending("room-1", "a");
    expect(readOutbox(ME).map((p) => p.client_id)).toEqual(["b"]);
    useRoomsStore.getState().removePending("room-1", "b");
    expect(box.has(`${OUTBOX_PREFIX}${ME}`)).toBe(false);
    stop();
  });

  it("come back after a reload and go out again by themselves", () => {
    const stop = startOutbox(ME, qc);
    useRoomsStore.getState().addPending(msg("a", { place: { name: "Cafe", lat: 1, lon: 2 } }));
    stop();
    useRoomsStore.setState({ pending: {} }); // the page reloaded

    const stop2 = startOutbox(ME, qc);
    expect(waiting().map((p) => [p.client_id, p.status, p.place?.name])).toEqual([["a", "failed", "Cafe"]]);
    expect(sent).toEqual(["a"]);
    // Still saved until the server has it.
    expect(readOutbox(ME).map((p) => p.client_id)).toEqual(["a"]);
    stop2();
  });

  it("leave another tab's waiting messages alone", () => {
    box.set(`${OUTBOX_PREFIX}${ME}`, JSON.stringify([msg("theirs")]));
    useRoomsStore.setState({ pending: { "room-1": [msg("theirs")] } }); // this tab already shows it
    const stop = startOutbox(ME, qc);
    expect(sent).toEqual([]); // nothing new to bring back
    useRoomsStore.getState().addPending(msg("mine"));
    useRoomsStore.getState().removePending("room-1", "mine");
    expect(readOutbox(ME).map((p) => p.client_id)).toEqual(["theirs"]);
    stop();
  });

  it("wait for a tap when too old for the server to recognise, and are dropped after a week", () => {
    const days = (n: number) => new Date(Date.now() - n * 24 * 3600_000).toISOString();
    box.set(`${OUTBOX_PREFIX}${ME}`, JSON.stringify([msg("fresh"), msg("old", { created_at: days(3) }), msg("ancient", { created_at: days(8) })]));
    const stop = startOutbox(ME, qc);
    expect(waiting().map((p) => p.client_id)).toEqual(["fresh", "old"]);
    expect(sent).toEqual(["fresh"]);
    stop();
  });

  it("are kept per person, and survive damaged storage", () => {
    box.set(`${OUTBOX_PREFIX}${ME}`, JSON.stringify([msg("a")]));
    expect(readOutbox("someone-else")).toEqual([]);
    box.set(`${OUTBOX_PREFIX}${ME}`, "{not json");
    expect(readOutbox(ME)).toEqual([]);
    box.set(`${OUTBOX_PREFIX}${ME}`, JSON.stringify([{ nonsense: true }, msg("ok")]));
    expect(readOutbox(ME).map((p) => p.client_id)).toEqual(["ok"]);
  });

  it("tells what changed by client id", () => {
    expect(outboxDiff([msg("a"), msg("b")], [msg("b"), msg("c")])).toMatchObject({ added: [{ client_id: "c" }], removed: ["a"] });
  });
});
