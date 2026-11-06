// The key a rules pack has to be signed by. It's pinned here, in the extension's own code,
// so nothing that arrives with a pack can vouch for itself.
//
// There's no owner key yet, so a release build has none and applies no pack, saying
// nothing about it. To change that, see the owner step in passwords/extension/rules/sign-pack.mjs.
// A test build has a throwaway key, whose private half is in rules/test-key.jwk.json.
declare const __TEST_BUILD__: boolean;

const RELEASE_PUBLIC_KEY: string | null = null;

export function packPublicKey(): string | null {
  return __TEST_BUILD__ ? "heZrLH9xTCDukIBUWQ9Wb9DXbnk7JoVONasFMAH8VL8" : RELEASE_PUBLIC_KEY;
}
