// Why a sign-in screen got no suggestions, and what it gets now: fields the parser used to
// pass over, and logins offered by name in an app nothing links yet (A75).
package org.promptly.sync.passwords

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.autofill.AppNames
import org.promptly.sync.passwords.autofill.AssetLinks
import org.promptly.sync.passwords.autofill.AutofillIndex
import org.promptly.sync.passwords.autofill.FieldNode
import org.promptly.sync.passwords.autofill.FillTarget
import org.promptly.sync.passwords.autofill.FormParser
import org.promptly.sync.passwords.autofill.IndexEntry
import org.promptly.sync.passwords.autofill.IndexLookup
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.Match
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AutofillSuggestTest {
    init {
        // OkHttp's Public Suffix List is an Android asset; the app gets this from androidx.startup.
        okhttp3.OkHttp.initialize(androidx.test.core.app.ApplicationProvider.getApplicationContext())
    }

    private fun field(id: String, vararg attrs: Pair<String, String>, hints: List<String> = emptyList(), inputType: Int = 0x1, idEntry: String? = null, hint: String? = null, focused: Boolean = false) =
        FieldNode(id, "android.widget.EditText", hints, if (attrs.isEmpty()) null else "input", attrs.toMap(), inputType, idEntry, hint, true, focused, 100, 40, null, null)

    // ---- The parser ----

    @Test fun anEmailAddressBoxIsAUsernameNotAStreetAddress() {
        // The commonest label there is. "address" used to rule it out, so an email-first
        // screen got no suggestions at all.
        for (f in listOf(
            field("e", hint = "Email address"),
            field("e", idEntry = "email_address"),
            field("e", "type" to "text", "placeholder" to "E-mail address"),
            field("e", "type" to "text", "name" to "emailAddress"),
            field("e", hint = "Username or email address"),
        )) {
            val form = FormParser.parse(listOf(f))
            assertEquals(listOf("e"), form.usernames)
            assertTrue(form.identity.isEmpty())
            assertTrue(form.hasLogin)
        }
    }

    @Test fun aStreetAddressIsStillNotALogin() {
        val form = FormParser.parse(listOf(field("a", hint = "Street address"), field("c", hint = "City"), field("z", hint = "Postcode")))
        assertFalse(form.hasLogin)
        assertEquals("a", form.identity["address1"])
    }

    @Test fun anEmailAddressBesideAPasswordIsFilledToo() {
        val form = FormParser.parse(listOf(field("e", hint = "Email address"), field("p", inputType = 0x81)))
        assertEquals(listOf("e"), form.usernames)
        assertEquals(listOf("p"), form.passwords)
    }

    @Test fun aPhoneNumberRightBeforeAPasswordIsTheUsername() {
        val form = FormParser.parse(listOf(field("m", hint = "Mobile number"), field("p", inputType = 0x81)))
        assertEquals(listOf("m"), form.usernames)
        assertTrue(form.identity.isEmpty())
        // With an email on the form the phone is just a phone.
        val signUp = FormParser.parse(listOf(field("e", "type" to "email"), field("m", "type" to "tel", "name" to "phone"), field("p", "type" to "password")))
        assertEquals(listOf("e"), signUp.usernames)
        assertEquals("m", signUp.identity["phone"])
    }

    @Test fun bankStyleIdsAreUsernames() {
        for (label in listOf("Customer ID", "Client number", "Member no", "Access ID", "CRN")) {
            assertEquals(label, listOf("u"), FormParser.parse(listOf(field("u", hint = label))).usernames)
        }
        // Not a card number, which is a card's.
        assertTrue(FormParser.parse(listOf(field("c", hint = "Card number"))).usernames.isEmpty())
    }

    @Test fun composeAndFlutterHintsAreRead() {
        val form = FormParser.parse(listOf(field("u", hints = listOf("newUsername")), field("p", hints = listOf("newPassword"))))
        assertEquals(listOf("u"), form.usernames)
        assertEquals(listOf("p"), form.newPasswords)
    }

    @Test fun askingByHandOnABoxNothingNamesStillGetsAnAnswer() {
        val nodes = listOf(field("x", idEntry = "field_1", focused = true), field("y", idEntry = "field_2"))
        assertTrue(FormParser.parse(nodes).isEmpty)
        val manual = FormParser.parse(nodes, manual = true)
        assertEquals(listOf("x"), manual.usernames)
        // A form that was understood isn't changed by asking by hand.
        val known = listOf(field("u", idEntry = "username"), field("s", idEntry = "search_box", focused = true))
        assertEquals(listOf("u"), FormParser.parse(known, manual = true).usernames)
    }

    // ---- Whose app is it ----

    @Test fun aPackageSpellsItsSiteBackwards() {
        assertEquals(listOf("netflix.com"), AppNames.reversedDomains("com.netflix.mediaclient"))
        // Three parts to say an Australian or British site.
        assertTrue("nab.com.au" in AppNames.reversedDomains("au.com.nab.mobile"))
        assertTrue("example.co.uk" in AppNames.reversedDomains("uk.co.example.app"))
        assertTrue(AppNames.reversedDomains("justone").isEmpty())
    }

    @Test fun packageOrLabelNamesASite() {
        assertTrue(AppNames.names("com.paypal.android.p2pmobile", null, "paypal.com"))
        assertTrue(AppNames.names("com.ubercab", "Uber", "uber.com"))
        assertTrue(AppNames.names("au.com.nab.mobile", "NAB", "nab.com.au"))
        assertTrue(AppNames.names("com.zhiliaoapp.musically", "TikTok", "tiktok.com"))
        assertTrue(AppNames.names("org.telegram.messenger", "Telegram", "telegram.org"))
        // Words every package has name nobody.
        assertFalse(AppNames.names("com.example.android.app", "Example", "android.com"))
        assertFalse(AppNames.names("com.example.mobile", "Example", "app.com"))
        assertFalse(AppNames.names("com.other.thing", "Other", "paypal.com"))
        assertTrue(AppNames.titled("Commonwealth Bank", "commonwealth bank"))
        assertFalse(AppNames.titled("App", "App"))
        assertFalse(AppNames.titled(null, "Netflix"))
    }

    @Test fun assetLinkCandidatesIncludeTheReversedPackage() {
        val c = AssetLinks.candidates("au.com.nab.mobile", setOf("nab.com.au", "example.com"))
        assertTrue("nab.com.au" in c)
        assertFalse("example.com" in c)
        assertTrue(AssetLinks.candidates("com.a.b.c.d.e.f", (1..20).map { "site$it.com" }.toSet()).size <= 5)
    }

    // ---- Guesses for an app nothing links yet ----

    private val entries by lazy { listOf(
        IndexEntry("netflix", "login", "Netflix", "ana", listOf(LoginUrl("https://www.netflix.com/login")), false, false),
        IndexEntry("netflix2", "login", "Netflix (kids)", "kid", listOf(LoginUrl("https://netflix.com")), false, false),
        IndexEntry("bank", "login", "Commonwealth Bank", "123", listOf(LoginUrl("https://www.my.commbank.com.au")), false, false),
        IndexEntry("titled", "login", "Fitness Pal", "bo", listOf(LoginUrl("https://accounts.example.net")), false, false),
        IndexEntry("other", "login", "Other", "cy", listOf(LoginUrl("https://other.example")), false, false),
        IndexEntry("never", "login", "Uber", "dee", listOf(LoginUrl("https://uber.com", "never")), false, false),
        IndexEntry("card", "card", "Netflix", null, emptyList(), false, false),
    ) }
    private val lookup by lazy { IndexLookup(entries) }

    private fun guess(pkg: String, label: String?, claimed: String? = null, recents: Map<String, Long> = emptyMap()) =
        AutofillIndex.guesses(lookup, FillTarget.App(pkg, "CERT", claimed), label, recents).map { it.itemId }

    @Test fun anUnlinkedAppIsOfferedTheLoginsItsNamePointsAt() {
        // Nothing links it, so it has no real matches...
        assertTrue(AutofillIndex.matches(lookup, FillTarget.App("com.netflix.mediaclient", "CERT", null), emptyMap()) { false }.isEmpty())
        // ...and it's offered these by name instead.
        assertEquals(setOf("netflix", "netflix2"), guess("com.netflix.mediaclient", "Netflix").toSet())
        assertEquals(listOf("bank"), guess("com.commbank.netbank", "CommBank"))
        assertEquals(listOf("titled"), guess("com.somebody.fp", "Fitness Pal"))
        assertTrue(guess("com.unrelated.thing", "Thing").isEmpty())
        // A login set to never match isn't dug up, and a card titled like the app isn't a login.
        assertTrue(guess("com.ubercab", "Uber").isEmpty())
    }

    @Test fun mostRecentlyUsedGuessComesFirstAndTheListIsShort() {
        assertEquals(listOf("netflix2", "netflix"), guess("com.netflix.mediaclient", "Netflix", recents = mapOf("netflix2" to 9L, "netflix" to 1L)))
        val many = IndexLookup((1..10).map { IndexEntry("n$it", "login", "N$it", null, listOf(LoginUrl("https://netflix.com")), false, false) })
        assertEquals(3, AutofillIndex.guesses(many, FillTarget.App("com.netflix.mediaclient", "C", null), "Netflix", emptyMap()).size)
    }

    @Test fun anAppShowingAWebPageGetsNoGuesses() {
        // What page a WebView shows is only the app's claim (A7): its logins stay behind Search,
        // and the package's own name doesn't offer one onto that page either.
        assertTrue(guess("com.some.browserish", "Some", claimed = "www.netflix.com").isEmpty())
        assertTrue(guess("com.netflix.mediaclient", "Netflix", claimed = "www.netflix.com").isEmpty())
    }

    @Test fun aGuessIsNeverARealMatch() {
        // The service only asks for guesses when there are no hits, and a guess carries no link:
        // the item still has to pass the check behind the pick.
        val app = FillTarget.App("com.netflix.mediaclient", "CERT", null)
        val e = AutofillIndex.guesses(lookup, app, "Netflix", emptyMap()).first()
        assertTrue(e.urls.none { Match.parseAppUrl(it.url) != null })
    }

    // ---- Chrome that isn't using this service ----

    @Test fun onlyAChromeThatSaysNoIsNamed() {
        // Off is named. On, and an old Chrome that doesn't say, aren't.
        assertEquals(listOf("com.chrome.beta"), ChromeSetup.offChannels(mapOf("com.android.chrome" to true, "com.chrome.beta" to false, "com.chrome.dev" to null)))
        assertTrue(ChromeSetup.offChannels(emptyMap()).isEmpty())
    }
}
