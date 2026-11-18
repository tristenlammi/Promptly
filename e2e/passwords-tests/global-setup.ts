// A fresh isolated stack has no admin, and sends everyone to first-run setup.
import { makeUsers, pruneOldUsers } from "./helpers";

export default async function globalSetup(): Promise<void> {
  pruneOldUsers();
  makeUsers(["root"], "admin");
}
