// Finds the fields in a screen, from what Android's autofill structure says about each
// one. Pure Kotlin over a small FieldNode so the JVM tests cover it; the service adapts
// AssistStructure into these. Field text is never read here, only its description.
package org.promptly.sync.passwords.autofill

import android.text.InputType

data class FieldNode<T>(
    val id: T,
    val className: String? = null,
    val hints: List<String> = emptyList(),
    val htmlTag: String? = null,
    val htmlAttrs: Map<String, String> = emptyMap(),
    val inputType: Int = 0,
    val idEntry: String? = null,
    val hint: String? = null,
    val visible: Boolean = true,
    val focused: Boolean = false,
    val width: Int = 100,
    val height: Int = 40,
    /** The web domain in force at this node, inherited down from the nearest ancestor. */
    val webDomain: String? = null,
    val webScheme: String? = null,
    val options: List<String>? = null,
    val isTextInput: Boolean = true,
    /** Where it is in its window, after scrolling. Null where nothing says. */
    val left: Int? = null,
    val top: Int? = null,
    val windowWidth: Int = 0,
    val windowHeight: Int = 0,
    /** Multiplied down from its ancestors. */
    val alpha: Float = 1f,
    /** The window and HTML form it belongs to. A card or an identity fills only in the focused one. */
    val section: String? = null,
)

class ParsedForm<T> {
    val usernames = ArrayList<T>()
    val passwords = ArrayList<T>()
    val newPasswords = ArrayList<T>()
    val otps = ArrayList<T>()
    val cards = LinkedHashMap<String, T>()
    val identity = LinkedHashMap<String, T>()
    val options = HashMap<T, List<String>>()
    var focused: T? = null
    var webDomain: String? = null
    var webScheme: String? = null
    /** The focused field is in a frame from another site than the page around it. */
    var frameDomain: String? = null

    val hasLogin: Boolean get() = usernames.isNotEmpty() || passwords.isNotEmpty() || newPasswords.isNotEmpty()
    val hasCard: Boolean get() = "number" in cards
    val hasIdentity: Boolean get() = identity.size >= 2
    val isEmpty: Boolean get() = !hasLogin && otps.isEmpty() && !hasCard && !hasIdentity
    val allIds: List<T> get() = (usernames + passwords + newPasswords + otps + cards.values + identity.values).distinct()
}

object FormParser {
    // Android's View.AUTOFILL_HINT_* values plus the HTML autocomplete tokens.
    private val USERNAME_HINTS = setOf("username", "emailaddress", "email", "user", "login", "webauthn username", "phone number")
    private val PASSWORD_HINTS = setOf("password", "current-password", "currentpassword")
    private val NEW_PASSWORD_HINTS = setOf("new-password", "newpassword")
    private val OTP_HINTS = setOf("one-time-code", "smsotpcode", "2facode", "otp", "smsotp")

    private val PASSWORD_WORDS = Regex("pass(word|wd|code)?|pwd|pin\\b|kennwort|contrase|mot.?de.?passe|senha|parol|wachtwoord|lösen|heslo", RegexOption.IGNORE_CASE)
    private val USER_WORDS = Regex("user|login|e-?mail|account|identifier|nickname|logon|uname|benutzer|usuario|utilisateur|courriel", RegexOption.IGNORE_CASE)
    private val OTP_WORDS = Regex("otp|2fa|mfa|totp|one.?time|verification.?code|security.?code|auth.?code|sms.?code|tfa|token", RegexOption.IGNORE_CASE)
    private val NOT_LOGIN = Regex("search|query|captcha|coupon|promo|voucher|address|city|zip|postcode|first.?name|last.?name|company", RegexOption.IGNORE_CASE)
    private val NEW_WORDS = Regex("new.?pass|confirm|repeat|retype|again|verify.?pass|create.?pass", RegexOption.IGNORE_CASE)

    private val CARD_HINTS = mapOf(
        "creditcardnumber" to "number", "cc-number" to "number",
        "creditcardsecuritycode" to "cvv", "cc-csc" to "cvv",
        "creditcardexpirationmonth" to "month", "cc-exp-month" to "month",
        "creditcardexpirationyear" to "year", "cc-exp-year" to "year",
        "creditcardexpirationdate" to "exp", "cc-exp" to "exp",
        "cc-name" to "name",
    )
    private val CARD_WORDS = listOf(
        "number" to Regex("card.?(num|no\\b)|cc.?num|cardnumber", RegexOption.IGNORE_CASE),
        "cvv" to Regex("cvv|cvc|csc|security.?code|card.?code", RegexOption.IGNORE_CASE),
        "month" to Regex("exp.*(month|mm\\b)|cc.?month", RegexOption.IGNORE_CASE),
        "year" to Regex("exp.*(year|yy)|cc.?year", RegexOption.IGNORE_CASE),
        "exp" to Regex("expir|exp.?date|mm.?/?.?yy", RegexOption.IGNORE_CASE),
        "name" to Regex("(card|cc).?(name|holder)|name.?on.?card", RegexOption.IGNORE_CASE),
    )
    private val IDENTITY_HINTS = mapOf(
        "personname" to "fullName", "name" to "fullName", "given-name" to "firstName", "personnamegiven" to "firstName",
        "additional-name" to "middleName", "family-name" to "lastName", "personnamefamily" to "lastName",
        "tel" to "phone", "phone" to "phone", "phonenumber" to "phone",
        "postaladdress" to "address1", "street-address" to "address1", "address-line1" to "address1", "address-line2" to "address2",
        "address-level2" to "city", "address-level1" to "state", "postalcode" to "postcode", "postal-code" to "postcode",
        "country" to "country", "country-name" to "country", "organization" to "company",
    )
    private val IDENTITY_WORDS = listOf(
        "firstName" to Regex("first.?name|given.?name|fname", RegexOption.IGNORE_CASE),
        "lastName" to Regex("last.?name|family.?name|surname|lname", RegexOption.IGNORE_CASE),
        "phone" to Regex("phone|mobile|\\btel\\b", RegexOption.IGNORE_CASE),
        "address1" to Regex("address|street", RegexOption.IGNORE_CASE),
        "city" to Regex("city|suburb|town", RegexOption.IGNORE_CASE),
        "state" to Regex("state|province|region", RegexOption.IGNORE_CASE),
        "postcode" to Regex("post.?code|zip", RegexOption.IGNORE_CASE),
        "country" to Regex("country", RegexOption.IGNORE_CASE),
        "company" to Regex("company|organi[sz]ation", RegexOption.IGNORE_CASE),
    )

    private fun isPasswordInput(t: Int): Boolean {
        val cls = t and InputType.TYPE_MASK_CLASS
        val v = t and InputType.TYPE_MASK_VARIATION
        return (cls == InputType.TYPE_CLASS_TEXT && (v == InputType.TYPE_TEXT_VARIATION_PASSWORD || v == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD || v == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)) ||
            (cls == InputType.TYPE_CLASS_NUMBER && v == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
    }

    private fun isEmailInput(t: Int): Boolean {
        val cls = t and InputType.TYPE_MASK_CLASS
        val v = t and InputType.TYPE_MASK_VARIATION
        return cls == InputType.TYPE_CLASS_TEXT && (v == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS || v == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS)
    }

    private fun described(n: FieldNode<*>): String = listOfNotNull(
        n.idEntry, n.hint, n.htmlAttrs["name"], n.htmlAttrs["id"], n.htmlAttrs["placeholder"], n.htmlAttrs["aria-label"], n.htmlAttrs["label"],
    ).joinToString(" ")

    /** Off to the side, or further above or below than scrolling a form would put it. Pages hide
     *  fields at left:-9999px to collect what a manager fills without being seen. */
    private fun offScreen(n: FieldNode<*>): Boolean {
        val x = n.left ?: return false
        val y = n.top ?: return false
        val w = n.windowWidth
        val h = n.windowHeight
        if (w <= 0 || h <= 0) return false
        return x + n.width <= 0 || x >= w || y + n.height <= -h || y >= 2 * h
    }

    /** Never hidden, see-through or off-screen fields: plan 6.6. */
    private fun fillable(n: FieldNode<*>): Boolean {
        if (!n.visible || !n.isTextInput) return false
        if (n.width <= 1 || n.height <= 1) return false
        if (n.alpha <= 0.05f || offScreen(n)) return false
        val tag = n.htmlTag?.lowercase()
        val type = n.htmlAttrs["type"]?.lowercase()
        if (tag != null && tag != "input" && tag != "select" && tag != "textarea") return false
        return type == null || type !in setOf("hidden", "submit", "button", "checkbox", "radio", "image", "reset", "file", "search")
    }

    private fun tokens(n: FieldNode<*>): List<String> {
        val out = ArrayList<String>()
        n.hints.forEach { out += it.lowercase().trim() }
        n.htmlAttrs["autocomplete"]?.lowercase()?.split(Regex("\\s+"))?.let { out += it }
        return out.filter { it.isNotEmpty() && it != "on" && it != "off" }
    }

    private val SECTION_TOKEN = Regex("^(section-.+|shipping|billing)$")

    /** The form, and autocomplete's own `section-*`, `shipping` and `billing`. */
    private fun sectionOf(n: FieldNode<*>): String = n.section.orEmpty() + "/" + tokens(n).filter { SECTION_TOKEN.matches(it) }.joinToString(",")

    fun <T> parse(nodes: List<FieldNode<T>>): ParsedForm<T> {
        val form = ParsedForm<T>()
        val focused = nodes.firstOrNull { it.focused }
        val domain = focused?.webDomain ?: nodes.firstOrNull { it.webDomain != null }?.webDomain
        val top = nodes.firstOrNull { it.webDomain != null }?.webDomain
        form.webDomain = domain
        form.webScheme = (focused?.webScheme) ?: nodes.firstOrNull { it.webDomain == domain }?.webScheme
        if (top != null && domain != null && top != domain) form.frameDomain = domain

        // Only fields in the same frame as the one being filled.
        val inFrame = nodes.filter { fillable(it) && (domain == null || it.webDomain == null || it.webDomain == domain) }
        if (focused != null && inFrame.any { it.id == focused.id }) form.focused = focused.id

        val focusedSection = focused?.let { sectionOf(it) }
        fun inSection(n: FieldNode<T>) = focusedSection == null || sectionOf(n) == focusedSection

        val plain = ArrayList<FieldNode<T>>()
        var firstPassword = -1
        for ((index, n) in inFrame.withIndex()) {
            n.options?.let { form.options[n.id] = it }
            val tok = tokens(n)
            val words = described(n)
            val type = n.htmlAttrs["type"]?.lowercase()

            val card = tok.firstNotNullOfOrNull { CARD_HINTS[it.replace("_", "")] } ?: CARD_WORDS.firstOrNull { it.second.containsMatchIn(words) }?.first
            when {
                tok.any { it in OTP_HINTS } -> form.otps += n.id
                tok.any { it in NEW_PASSWORD_HINTS } -> form.newPasswords += n.id
                tok.any { it in PASSWORD_HINTS } -> form.passwords += n.id
                tok.any { it in USERNAME_HINTS } -> form.usernames += n.id
                card != null -> if (inSection(n)) form.cards.putIfAbsent(card, n.id)
                tok.firstNotNullOfOrNull { IDENTITY_HINTS[it] } != null -> if (inSection(n)) form.identity.putIfAbsent(tok.firstNotNullOf { IDENTITY_HINTS[it] }, n.id)
                type == "password" || isPasswordInput(n.inputType) -> if (NEW_WORDS.containsMatchIn(words)) form.newPasswords += n.id else form.passwords += n.id
                OTP_WORDS.containsMatchIn(words) && !PASSWORD_WORDS.containsMatchIn(words) -> form.otps += n.id
                PASSWORD_WORDS.containsMatchIn(words) && !NOT_LOGIN.containsMatchIn(words) -> form.passwords += n.id
                type == "email" || isEmailInput(n.inputType) -> form.usernames += n.id
                USER_WORDS.containsMatchIn(words) && !NOT_LOGIN.containsMatchIn(words) -> form.usernames += n.id
                IDENTITY_WORDS.firstOrNull { it.second.containsMatchIn(words) } != null ->
                    if (inSection(n)) form.identity.putIfAbsent(IDENTITY_WORDS.first { it.second.containsMatchIn(words) }.first, n.id)
                else -> plain += n
            }
            if (firstPassword < 0 && (n.id in form.passwords || n.id in form.newPasswords)) firstPassword = index
        }
        // No description at all: the text field right before a password is the username.
        if (form.usernames.isEmpty() && firstPassword > 0) {
            for (i in firstPassword - 1 downTo 0) {
                val n = inFrame[i]
                if (n in plain) {
                    form.usernames += n.id
                    break
                }
            }
        }
        // A "password" field beside a "new password" on a change form is the old one; two
        // password fields with nothing else said are a sign-up's password and its repeat.
        if (form.newPasswords.isEmpty() && form.passwords.size == 2 && form.usernames.isEmpty().not()) {
            form.newPasswords += form.passwords
            form.passwords.clear()
        }
        return form
    }
}
