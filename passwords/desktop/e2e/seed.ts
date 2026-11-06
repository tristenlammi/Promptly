// Test helpers on the real client core, bundled by app.test.mjs and run in Node. They stand in
// for "the person's other device": making the vault, approving the connect, reading back.
import { VaultApi } from "../../../frontend/src/passwords/core/api";
import { fromB64u } from "../../../frontend/src/passwords/core/bytes";
import { readEncryptedExport } from "../../../frontend/src/passwords/core/exporter";
import { encodeSecretKey } from "../../../frontend/src/passwords/core/keys";
import { MemoryStore } from "../../../frontend/src/passwords/core/store";
import { VaultClient } from "../../../frontend/src/passwords/core/vault";

export async function createVault(base: string, token: string, master: string) {
  const store = new MemoryStore();
  const vault = new VaultClient(new VaultApi(base, () => token), store, "web");
  const { secretKey } = await vault.setup(master);
  await vault.api.confirmKit();
  return { secretKeyText: await encodeSecretKey(secretKey), vault, secretKey };
}

export async function approveConnect(base: string, token: string, code: string) {
  await new VaultApi(base, () => token).connectApprove(code);
}

export async function titlesOnServer(vault: VaultClient) {
  await vault.sync();
  return vault.allItems().map((i) => ({ title: i.body.title, username: i.body.username, password: i.body.password }));
}

export async function addSshItem(vault: VaultClient, title: string, sshPublic: string, sshPrivate: string) {
  const id = await vault.personalVaultId();
  await vault.saveNew(id, vault.newItemBody("ssh", title, { sshPublic, sshPrivate }));
  await vault.sync();
}

export async function openBackup(text: string, password: string) {
  return readEncryptedExport(JSON.parse(text), password);
}

export { fromB64u };
