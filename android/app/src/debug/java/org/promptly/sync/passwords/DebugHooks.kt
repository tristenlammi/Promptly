package org.promptly.sync.passwords

/** Debug builds only (src/release has the empty twin). So a test app can stand in for a
 *  browser on the allowlist, and a test site can serve asset links on the phone itself. */
object DebugHooks {
    val browsersWithoutCertCheck: Set<String> = setOf("org.promptly.pwtest.browser")
    val assetLinksBase: Map<String, String> = mapOf("passkey-test.promptly.test" to "http://localhost:18765", "promptly.test" to "http://localhost:18765")
}
