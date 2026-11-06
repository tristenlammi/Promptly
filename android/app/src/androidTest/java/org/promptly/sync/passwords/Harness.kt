// Shared by the instrumented tests. They run in the app's own process, so the vault they
// seed is the same object the real AutofillService and activities use. Throwaway values only.
package org.promptly.sync.passwords

import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import kotlinx.serialization.json.JsonPrimitive
import org.promptly.sync.passwords.autofill.AutofillIndex
import org.promptly.sync.passwords.autofill.signingCerts
import org.promptly.sync.passwords.core.CachedAccount
import org.promptly.sync.passwords.core.CachedVault
import org.promptly.sync.passwords.core.KdfParams
import org.promptly.sync.passwords.core.Keyset
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.b64u
import org.promptly.sync.passwords.core.deriveRoot
import org.promptly.sync.passwords.core.grantVaultKey
import org.promptly.sync.passwords.core.randomBytes
import org.promptly.sync.passwords.core.randomUuid
import org.promptly.sync.passwords.core.sealField
import org.promptly.sync.passwords.core.wrapKeyset

object Harness {
    const val MASTER = "correct horse battery staple 7!"
    const val TEST_APP = "org.promptly.pwtest"
    const val TEST_BROWSER = "org.promptly.pwtest.browser"
    const val AUTOFILL = "org.promptly.app/org.promptly.sync.passwords.autofill.PromptlyAutofillService"
    const val CREDENTIAL = "org.promptly.app/org.promptly.sync.passwords.credentials.PromptlyCredentialProviderService"
    private const val T = "PwTest"

    val inst get() = InstrumentationRegistry.getInstrumentation()
    val ctx get() = inst.targetContext
    val device: UiDevice by lazy { UiDevice.getInstance(inst) }

    fun shell(cmd: String): String {
        val fd = inst.uiAutomation.executeShellCommand(cmd)
        return ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().decodeToString() }
    }

    fun note(msg: String) {
        Log.i(T, msg)
        inst.sendStatus(0, android.os.Bundle().apply { putString("note", msg) })
    }

    fun certOf(pkg: String): String = signingCerts(ctx, pkg).single()

    /** A real account in the real offline copy and Keystore, on no server at all: the
     *  server address refuses connections, so every sync reports offline. */
    fun seedOffline(server: String = "http://localhost:1"): VaultClient {
        clearScreen()
        Pw.init(ctx)
        runCatching { Pw.forgetDevice() }
        Pw.prefs.setupGuideDone = true
        val secret = randomBytes(16)
        val salt = randomBytes(16)
        val accountId = randomUuid()
        val userId = randomUuid()
        val vaultId = randomUuid()
        val root = deriveRoot(MASTER, secret, salt, KdfParams.FLOOR)
        val keyset = Keyset.random()
        val vaultKey = randomBytes(32)
        val grant = grantVaultKey(userId, keyset, vaultId, userId, keyset.x25519Pub, 1, vaultKey)
        Pw.connect(server, "pwd_offline", "device-1")
        Pw.db.clear()
        Pw.db.putAccount(CachedAccount(accountId, userId, KdfParams.FLOOR, b64u(salt), b64u(wrapKeyset(root.unlock, accountId, keyset)), b64u(keyset.x25519Pub), b64u(keyset.ed25519Pub), true, null))
        Pw.db.putVault(CachedVault(vaultId, "personal", 0, 0, 1, sealField(vaultKey, vaultId, "name", JsonPrimitive("Personal")), "manage", b64u(grant.wrapped), b64u(grant.signature), userId, 1, true, 1))
        val client = Pw.client()!!
        client.keeper.save(secret)
        AutofillIndex.clear(ctx)
        client.unlock(MASTER)
        Pw.touch()
        return client
    }

    fun rebuildIndex() {
        AutofillIndex.rebuildNow(ctx, Pw.client()!!)
    }

    fun setAutofill(on: Boolean) {
        if (on) {
            shell("settings put secure autofill_service $AUTOFILL")
        } else {
            shell("settings delete secure autofill_service")
        }
        // Reset any saved "never for this app" state from an earlier run.
        shell("cmd autofill reset")
    }

    fun launch(pkg: String, activity: String, extras: String = "") {
        shell("am force-stop $pkg")
        shell("am start -W -n $pkg/$TEST_APP.$activity $extras")
        waitFor(By.pkg(pkg), 15_000)
    }

    fun waitFor(sel: BySelector, ms: Long = 15_000): UiObject2 =
        device.wait(Until.findObject(sel), ms) ?: run {
            val dump = runCatching { dumpWindow() }.getOrDefault("")
            throw AssertionError("Not on screen: $sel\nWindow:\n$dump")
        }

    fun gone(sel: BySelector, ms: Long = 5_000): Boolean = device.wait(Until.gone(sel), ms) ?: false

    fun has(sel: BySelector, ms: Long = 2_500): Boolean = device.wait(Until.hasObject(sel), ms) ?: false

    fun dumpWindow(): String {
        val os = java.io.ByteArrayOutputStream()
        device.dumpWindowHierarchy(os)
        return Regex("(?:text|content-desc|resource-id|package)=\"([^\"]+)\"").findAll(os.toString()).map { it.groupValues[1] }.filter { !it.contains("systemui") && !it.contains("inputmethod") }.distinct().joinToString(" | ").take(1500)
    }

    /** The WebView's own accessibility tree names its inputs by their HTML ids. */
    fun tapWebField(id: String) {
        waitFor(By.res(id), 20_000)
        Thread.sleep(500)
        device.findObject(By.res(id)).click()
    }

    /** Whatever an earlier session left ringing on this AVD shouldn't cover the test. */
    fun clearScreen() {
        shell("am force-stop com.google.android.deskclock")
        shell("input keyevent KEYCODE_WAKEUP")
        shell("cmd statusbar collapse")
        // The "Viewing full screen" first-use hint.
        shell("settings put secure immersive_mode_confirmations confirmed")
    }

    /** Tap a suggestion, in the keyboard's strip or the dropdown. The field keeps focus, so
     *  a second tap on it asks again if the first answer lost a race with the keyboard. */
    fun pick(title: String) {
        suggestion(By.text(title)).click()
    }

    fun waitSuggestion(text: String) {
        suggestion(By.textContains(text))
    }

    /** A suggestion chip. The system log says it's shown (`onShown`) on the runs that miss here:
     *  its window just isn't always visible to UiAutomator. So hide the keyboard and ask again. */
    fun suggestion(sel: BySelector): UiObject2 {
        for (i in 1..3) {
            device.wait(Until.findObject(sel), 8_000)?.let { return it }
            note("Suggestion $sel hadn't shown after 8 s; asked again")
            dismissKeyboard()
            Thread.sleep(500)
            device.findObject(By.focused(true))?.click()
        }
        return waitFor(sel, 8_000)
    }

    fun tapField(desc: String) {
        val f = waitFor(By.desc(desc))
        f.click()
    }

    fun textOf(desc: String): String = waitFor(By.desc(desc)).text ?: ""

    fun waitText(desc: String, want: String, ms: Long = 8_000) {
        val end = System.currentTimeMillis() + ms
        var last = ""
        while (System.currentTimeMillis() < end) {
            last = runCatching { device.findObject(By.desc(desc))?.text ?: "" }.getOrDefault("")
            if (last == want) return
            Thread.sleep(150)
        }
        throw AssertionError("$desc was \"$last\", wanted \"$want\"\nWindow:\n${dumpWindow()}")
    }

    /** Type into a Compose field found by its test tag. */
    fun fill(tag: String, text: String) {
        val f = waitFor(By.res(tag))
        f.click()
        f.text = text
    }

    fun tap(tag: String, ms: Long = 15_000) {
        waitFor(By.res(tag), ms).click()
    }

    /** Several suites share this stack, and its rate limits: wait them out rather than fail. */
    fun <T> retrying429(block: () -> T): T {
        var waited = 0
        while (true) {
            try {
                return block()
            } catch (e: org.promptly.sync.passwords.core.ApiError) {
                if (e.status != 429 || waited > 180) throw e
                val s = (e.retryAfter ?: 30) + 1
                note("429 from the stack; waiting $s s")
                waited += s
                Thread.sleep(s * 1000L)
            }
        }
    }

    /** Everything known about what just went wrong, for the instrumentation output. */
    fun capture(label: String) {
        note("CAPTURE $label: window: ${dumpWindow()}")
        note("CAPTURE $label: last network problem: ${Pw.client()?.api?.lastProblem}")
        note("CAPTURE $label: app log: " + shell("logcat -d -t 400 -s PwTest:* PromptlyPasswords:* AndroidRuntime:E").takeLast(1500))
        runCatching {
            val out = java.io.File(ctx.cacheDir, "capture-$label.png")
            device.takeScreenshot(out)
            note("CAPTURE $label: screenshot at ${out.path} (black if FLAG_SECURE)")
        }
    }

    /** Tap something that talks to the server, and wait for what should come next. A 429 is
     *  waited out. "Can't be reached" gets captured, so it's explained, then tried again. */
    fun tapThrough(tag: String, next: BySelector, ms: Long = 60_000) {
        var tries = 0
        while (true) {
            tap(tag)
            val end = System.currentTimeMillis() + ms
            var problem: String? = null
            while (System.currentTimeMillis() < end) {
                if (device.hasObject(next)) return
                problem = runCatching { device.findObject(By.res("error"))?.text }.getOrNull()
                if (problem != null) break
                Thread.sleep(250)
            }
            if (problem == null) {
                capture("timeout-$tag")
                throw AssertionError("Nothing came after $tag")
            }
            tries++
            when {
                problem.contains("Too many tries") && tries < 8 -> {
                    val s = Regex("Wait (\\d+)").find(problem)?.groupValues?.get(1)?.toIntOrNull() ?: 60
                    note("$tag: rate limited, waiting ${s + 1} s")
                    Thread.sleep((s + 1) * 1000L)
                }
                problem.contains("can't be reached") && tries < 4 -> {
                    capture("unreachable-$tag-$tries")
                    Thread.sleep(15_000)
                }
                else -> {
                    capture("error-$tag")
                    throw AssertionError("$tag: $problem")
                }
            }
        }
    }

    /** Scroll a long screen slowly until this is there and has stopped moving, then tap it.
     *  The keyboard goes first: it covers the bottom of the form and eats swipes. */
    fun scrollTap(tag: String) {
        dismissKeyboard()
        val h = device.displayHeight
        var tries = 0
        while (device.findObject(By.res(tag)) == null && tries++ < 12) {
            device.swipe(device.displayWidth / 2, h * 45 / 100, device.displayWidth / 2, h * 15 / 100, 30)
            Thread.sleep(500)
        }
        waitFor(By.res(tag), 3_000)
        var last = device.findObject(By.res(tag)).visibleBounds
        for (i in 1..10) {
            Thread.sleep(200)
            val now = device.findObject(By.res(tag)).visibleBounds
            if (now == last) break
            last = now
        }
        device.findObject(By.res(tag)).click()
    }

    /** The same scrolling, for something that's only to be looked at. */
    fun scrollToTag(tag: String) {
        dismissKeyboard()
        val h = device.displayHeight
        var tries = 0
        while (device.findObject(By.res(tag)) == null && tries++ < 12) {
            device.swipe(device.displayWidth / 2, h * 45 / 100, device.displayWidth / 2, h * 15 / 100, 30)
            Thread.sleep(500)
        }
        waitFor(By.res(tag), 3_000)
    }

    fun dismissKeyboard() {
        if (shell("dumpsys input_method").contains("mInputShown=true")) {
            device.pressBack()
            Thread.sleep(400)
        }
    }

    /** Dismiss any leftover autofill dropdown and keyboard. */
    fun settle() {
        device.pressBack()
        Thread.sleep(200)
    }

    fun home() {
        device.pressHome()
        Thread.sleep(300)
    }
}
