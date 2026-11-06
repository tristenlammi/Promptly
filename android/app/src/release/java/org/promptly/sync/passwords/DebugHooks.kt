package org.promptly.sync.passwords

/** Nothing in a release build. The debug twin lets the test app act as a browser. */
object DebugHooks {
    val browsersWithoutCertCheck: Set<String> = emptySet()
    val assetLinksBase: Map<String, String> = emptyMap()
}
