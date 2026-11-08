// Browser sync on the phone: only receiving a tab a browser sent here (passwords/SYNC.md).
// The opening is VaultClient.takeSentTabs; the rule for what may be opened is here.
package org.promptly.sync.passwords.core

/** Only http and https with a host, of a sane length: never javascript:, intent:, file: or content:. */
fun isWebAddress(url: String): Boolean = url.length <= 4096 && runCatching {
    val u = java.net.URI(url)
    (u.scheme?.lowercase() == "https" || u.scheme?.lowercase() == "http") && !u.host.isNullOrEmpty()
}.getOrDefault(false)

/** The key every device derives from the personal vault's key (CRYPTO_SPEC section 13). */
fun browserSyncKey(personalVaultKey: ByteArray, personalVaultId: String): ByteArray =
    Primitives.hkdf(personalVaultKey, utf8(personalVaultId), "promptly-pw/v1/browser-sync")

/** A sent tab's record, opened, or null if it doesn't open or isn't a web address. */
fun openSentTab(key: ByteArray, vaultId: String, deviceId: String?, slot: String, blob: ByteArray): String? = runCatching {
    val plain = unpad(open(key, blob, aad(vaultId, "sent:${deviceId ?: ""}:$slot", "browser-sync")))
    val o = kotlinx.serialization.json.Json.parseToJsonElement(String(plain, Charsets.UTF_8)) as kotlinx.serialization.json.JsonObject
    val v = (o["v"] as? kotlinx.serialization.json.JsonPrimitive)?.content
    (o["url"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.takeIf { v == "1" && isWebAddress(it) }
}.getOrNull()
