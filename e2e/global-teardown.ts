import { seed, stopMockModel } from "./lib/stack";

export default async function globalTeardown(): Promise<void> {
  // Hide the fake models again and stop the fake model server. Set
  // E2E_KEEP_MOCK=1 to leave both up for poking at a failure by hand.
  if (process.env.E2E_KEEP_MOCK) return;
  seed("teardown");
  stopMockModel();
}
