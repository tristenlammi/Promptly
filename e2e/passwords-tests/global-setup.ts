// A fresh isolated stack has no admin, and sends everyone to first-run setup.
import { makeUsers } from "./helpers";

export default async function globalSetup(): Promise<void> {
  makeUsers(["root"], "admin");
}
