// Plan 13.7, in the core: 5,000 items against the real API.
//   PW_STACK_URL=http://localhost:8092 PW_PERF=1 npx vitest run src/passwords/core/perf.test.ts
import { describe, expect, it, vi } from "vitest";

import { VaultApi } from "./api";
import { newBody } from "./model";
import { MemoryStore } from "./store";
import { BASE_URL, makeUsers } from "./testing/stack";
import { VaultClient } from "./vault";

const MASTER = "correct horse battery staple 7!";
vi.setConfig({ testTimeout: 900_000 });

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

describe.skipIf(!process.env.PW_STACK_URL || !process.env.PW_PERF)("5,000 items", () => {
  it("unlock, search and delta sync", async () => {
    const [u] = makeUsers("perfcore");
    const store = new MemoryStore();
    const c = new VaultClient(new VaultApi(BASE_URL, () => u.token), store);
    const { secretKey } = await c.setup(MASTER);
    const vid = await c.personalVaultId();
    for (let i = 0; i < 5000; i++) {
      await c.saveNew(vid, newBody("login", `Site ${i}`, { username: `user${i}@example.com`, password: `Pw-${i}-xYz!9`, urls: [{ url: `https://s${i}.example.com/login` }], notes: `note ${i}` }));
    }
    const t0 = performance.now();
    await c.sync();
    const firstPush = performance.now() - t0;

    // A second device: the full first pull.
    const other = new VaultClient(new VaultApi(BASE_URL, () => u.token), new MemoryStore());
    const t1 = performance.now();
    await other.unlock(MASTER, secretKey);
    await other.sync();
    const firstPull = performance.now() - t1;
    expect(other.allItems()).toHaveLength(5000);

    const searches: number[] = [];
    for (const q of ["site 4321", "user77", "s1234.example", "note 3", "nothing matches this"]) {
      const t = performance.now();
      other.search(q);
      searches.push(performance.now() - t);
    }

    // After key stretching: lock, then open again from the same secret.
    const secret = await other.exportUnlockSecret(MASTER);
    await other.lock();
    const t2 = performance.now();
    await other.unlockWithSecret(secret);
    const unlockAfterKdf = performance.now() - t2;

    // One change, seen elsewhere.
    const first = c.allItems()[0];
    await c.update(first.id, { ...first.body, notes: "changed" });
    await c.sync();
    const t3 = performance.now();
    await other.sync();
    const deltaSync = performance.now() - t3;
    expect(other.get(first.id)?.body.notes).toBe("changed");

    const heapMb = Math.round(process.memoryUsage().heapUsed / 1048576);
    console.log(JSON.stringify({ firstPushMs: Math.round(firstPush), firstPullMs: Math.round(firstPull), unlockAfterKdfMs: Math.round(unlockAfterKdf), searchMs: searches.map((s) => Number(s.toFixed(1))), deltaSyncMs: Math.round(deltaSync), heapMb }));
    expect(median(searches)).toBeLessThan(50);
    expect(deltaSync).toBeLessThan(1000);
  });
});
