// The 2026-11-08 security review's Android findings that can be checked without a phone. The
// trust-book ones (F1, F2, F6) are in HostileTest, next to the rest of the hostile-server tests.
package org.promptly.sync.passwords

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.promptly.sync.passwords.autofill.FillTarget
import org.promptly.sync.passwords.autofill.SaveMatch
import org.promptly.sync.passwords.core.Item
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.newBody

class SecurityReviewTest {
    private fun login(vararg urls: LoginUrl) = Item("i1", "v1", 1, false, "2026-11-08T00:00:00Z", newBody("login", "Bank").withText("username", "ana").withUrls(urls.toList()))

    private val cert = "q1w2e3r4t5y6u7i8o9p0q1w2e3r4t5y6u7i8o9p0abc"

    /** F8: a login imported with no certificate isn't "this app", whoever claims the package. */
    @Test fun aSaveOnlyUpdatesAnAppLoginWhoseCertificateMatches() {
        val imported = login(LoginUrl("${Match.APP_SCHEME}com.bank.app", "never"))
        val pinned = login(Match.appUrl("com.bank.app", cert))
        // A sideloaded app with the bank's package name, and its own certificate or none we could read.
        assertFalse(SaveMatch.hitsTarget(FillTarget.App("com.bank.app", null, null), imported))
        assertFalse(SaveMatch.hitsTarget(FillTarget.App("com.bank.app", "other-cert", null), imported))
        assertFalse(SaveMatch.hitsTarget(FillTarget.App("com.bank.app", null, null), pinned))
        assertFalse(SaveMatch.hitsTarget(FillTarget.App("com.bank.app", "other-cert", null), pinned))
        // The real app.
        assertTrue(SaveMatch.hitsTarget(FillTarget.App("com.bank.app", cert, null), pinned))
    }
}
