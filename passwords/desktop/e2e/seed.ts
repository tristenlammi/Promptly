// Test helpers on the real client core, bundled by app.test.mjs and run in Node. They stand in
// for "the person's other device": making the vault, approving the connect, reading back.
import { VaultApi } from "../../../frontend/src/passwords/core/api";
import { b64u, fromB64u } from "../../../frontend/src/passwords/core/bytes";
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

export async function addLogin(vault: VaultClient, fields: { title: string; username: string; password: string; reprompt?: boolean }) {
  const id = await vault.personalVaultId();
  await vault.saveNew(id, vault.newItemBody("login", fields.title, fields));
  await vault.sync();
}

export async function addRepromptSshItem(vault: VaultClient, title: string, sshPublic: string, sshPrivate: string) {
  const id = await vault.personalVaultId();
  await vault.saveNew(id, vault.newItemBody("ssh", title, { sshPublic, sshPrivate, reprompt: true }));
  await vault.sync();
}

/** Another person shares a vault with this one's user, with the fill-only role. */
export async function shareFillOnly(sharer: VaultClient, member: VaultClient, item: { title: string; username: string; password: string; totpSecret: string }) {
  const shared = await sharer.createSharedVault("Fill-only for the test");
  await sharer.saveNew(shared, sharer.newItemBody("login", item.title, { username: item.username, password: item.password, totp: { secret: item.totpSecret } }));
  await sharer.sync();
  await sharer.addMember(shared, member.userId!, "fill");
  await member.acceptVault(shared);
  return shared;
}

export async function newDeviceRequest(vault: VaultClient, name: string) {
  const pub = crypto.getRandomValues(new Uint8Array(32));
  return vault.api.deviceRequestCreate(name, "web", b64u(pub));
}

export async function openBackup(text: string, password: string) {
  return readEncryptedExport(JSON.parse(text), password);
}

export { fromB64u };
