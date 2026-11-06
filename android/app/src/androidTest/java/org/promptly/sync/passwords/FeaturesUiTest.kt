// The features added after the first pass, through the real screens. The first group runs on
// the seeded offline vault. The second talks to the real :8092 stack with throwaway users the
// host passes in (android/run-passwords-tests.ps1), and skips itself without them.
package org.promptly.sync.passwords

import android.content.ContentValues
import android.content.Intent
import android.os.Environment
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.promptly.sync.passwords.Harness.ctx
import org.promptly.sync.passwords.Harness.device
import org.promptly.sync.passwords.Harness.fill
import org.promptly.sync.passwords.Harness.has
import org.promptly.sync.passwords.Harness.tap
import org.promptly.sync.passwords.Harness.waitFor
import org.promptly.sync.passwords.core.Importers
import org.promptly.sync.passwords.core.LoginUrl
import org.promptly.sync.passwords.core.MemoryKeeper
import org.promptly.sync.passwords.core.MemoryStore
import org.promptly.sync.passwords.core.SecretKeys
import org.promptly.sync.passwords.core.VaultApi
import org.promptly.sync.passwords.core.VaultClient
import org.promptly.sync.passwords.core.newBody
import org.promptly.sync.passwords.ui.PasswordsActivity

@RunWith(AndroidJUnit4::class)
class FeaturesUiTest {
    @Before fun setUp() {
        Harness.home()
        Pw.init(ctx)
        Pw.prefs.lockOnScreenOff = false
    }

    private fun open() {
        ctx.startActivity(Intent(ctx, PasswordsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** A real file in Downloads, for the system picker to find. */
    private fun fileInDownloads(name: String, text: String, mime: String = "text/plain") {
        val r = ctx.contentResolver
        r.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI, "${MediaStore.Downloads.DISPLAY_NAME}=?", arrayOf(name))
        val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        })!!
        r.openOutputStream(uri)!!.use { it.write(text.toByteArray()) }
    }

    /** Android's own file picker. It may open on Recent, or on the last folder. */
    private fun pickFromSystem(name: String) {
        waitFor(By.pkg("com.google.android.documentsui"), 20_000)
        var hit = device.wait(androidx.test.uiautomator.Until.findObject(By.text(name)), 4_000)
        if (hit == null) {
            device.findObject(By.desc("Show roots"))?.click()
            Thread.sleep(800)
            device.findObject(By.text("Downloads"))?.click()
            hit = waitFor(By.text(name), 10_000)
        }
        hit.click()
    }

    private fun saveInSystem(name: String) {
        waitFor(By.pkg("com.google.android.documentsui"), 20_000)
        val field = device.wait(androidx.test.uiautomator.Until.findObject(By.res("android:id/title")), 3_000)
        Harness.note("Save picker opened; suggested name ${field?.text}")
        val existing = device.findObject(By.text(name))
        Thread.sleep(800)
        (device.findObject(By.text("SAVE")) ?: device.findObject(By.text("Save")) ?: device.findObject(By.res("android:id/button1"))).click()
        // Saving over a file of that name asks first.
        val overwrite = device.wait(androidx.test.uiautomator.Until.findObject(By.res("android:id/button1")), 2_000)
        if (existing != null && overwrite != null) overwrite.click()
    }

    private fun shellCat(path: String) = Harness.shell("cat $path")

    @Test fun securityCheckFindsIssuesOnScreen() {
        val client = Harness.seedOffline()
        val vault = client.personalVaultId()
        client.saveNew(vault, newBody("login", "Weak one").withText("password", "password").withUrls(listOf(LoginUrl("http://insecure.example"))))
        client.saveNew(vault, newBody("login", "Same A").withText("password", "kX9!vQ2#mL7pR4zQ").withUrls(listOf(LoginUrl("https://a.example"))))
        client.saveNew(vault, newBody("login", "Same B").withText("password", "kX9!vQ2#mL7pR4zQ").withUrls(listOf(LoginUrl("https://b.example"))))
        open()
        tap("tab-more", 30_000)
        tap("open-security")
        assertEquals("Checked 3 logins.", waitFor(By.res("health-checked"), 30_000).text)
        assertEquals("1", device.findObject(By.res("health-count-weak")).text)
        assertEquals("2", device.findObject(By.res("health-count-reused")).text)
        // Offline: it says the breach check didn't happen, rather than saying all's well.
        assertTrue(has(By.textContains("breaches weren't checked"), 3_000))
        tap("health-weak")
        Harness.scrollTap("health-http")
        assertEquals("1", device.findObject(By.res("health-count-http")).text)
    }

    @Test fun wifiItemShowsAJoinQr() {
        val client = Harness.seedOffline()
        client.saveNew(client.personalVaultId(), newBody("wifi", "Home wifi").withText("ssid", "Home").withText("wifiPassword", "pw-Home-1!"))
        open()
        tap("item-Home wifi", 30_000)
        tap("wifi-qr-toggle")
        waitFor(By.res("wifi-qr"))
    }

    @Test fun importCsvThroughTheSystemPickerWithPreviewAndDedupe() {
        val client = Harness.seedOffline()
        client.saveNew(client.personalVaultId(), newBody("login", "Already here").withText("username", "dup").withText("password", "dup-pw").withUrls(listOf(LoginUrl("https://dup.example"))))
        val name = "pwtest-import-${System.currentTimeMillis()}.csv"
        fileInDownloads(name, "name,url,username,password,note\nGitHub,https://github.com/login,ana,pw-Git-1!,hello\nDuplicate,https://dup.example,dup,dup-pw,\n", "text/csv")
        open()
        tap("tab-more", 30_000)
        tap("open-transfer")
        tap("import-pick")
        pickFromSystem(name)
        assertEquals("Browser: 1 to add, 1 duplicates left out", waitFor(By.res("import-summary"), 20_000).text)
        waitFor(By.res("import-row-GitHub"))
        tap("import-confirm")
        waitFor(By.res("transfer-message"), 20_000)
        val added = client.allItems().first { it.body.title == "GitHub" }
        assertEquals("pw-Git-1!", added.body.password)
        assertEquals(2, client.allItems().size)
    }

    @Test fun encryptedExportThenImportBack() {
        val client = Harness.seedOffline()
        client.saveNew(client.personalVaultId(), newBody("login", "To export").withText("password", "pw-Export-1!"))
        val name = "promptly-passwords-export.json"
        Harness.shell("rm -f /sdcard/Download/$name")
        open()
        tap("tab-more", 30_000)
        tap("open-transfer")
        // A wrong master password stops it, and no file picker opens.
        Harness.scrollTap("export-master")
        fill("export-master", "not the master password")
        Harness.scrollTap("export-password")
        fill("export-password", "export-file-password")
        Harness.dismissKeyboard()
        fill("export-password-again", "export-file-password")
        Harness.scrollTap("export-encrypted")
        waitFor(By.textContains("master password isn't right"), 20_000)
        assertFalse(has(By.pkg("com.google.android.documentsui"), 500))
        Harness.scrollTap("export-master")
        fill("export-master", Harness.MASTER)
        Harness.scrollTap("export-encrypted")
        saveInSystem(name)
        waitFor(By.res("transfer-message"), 20_000)
        val text = shellCat("/sdcard/Download/$name")
        assertTrue(text, text.contains("promptly-pw-export"))
        assertFalse(text.contains("pw-Export-1!"))
        val back = Importers.importFile(name, text.toByteArray(), "export-file-password")
        assertEquals("pw-Export-1!", back.items.single().body.password)
        Harness.shell("rm -f /sdcard/Download/$name")
        // Plain needs the master password too, and the word typed in full.
        waitFor(By.res("export-master"))
        fill("export-master", Harness.MASTER)
        Harness.scrollTap("export-typed")
        fill("export-typed", "export")
        Harness.scrollTap("export-plain")
        assertFalse(waitFor(By.res("export-plain")).isEnabled)
        Harness.scrollTap("export-typed")
        fill("export-typed", "EXPORT")
        val plainName = "promptly-passwords.json"
        Harness.shell("rm -f /sdcard/Download/$plainName")
        Harness.scrollTap("export-plain")
        saveInSystem(plainName)
        Thread.sleep(1500)
        val plain = shellCat("/sdcard/Download/$plainName")
        assertTrue(plain.take(200), plain.contains("pw-Export-1!"))
        Harness.shell("rm -f /sdcard/Download/$plainName")
    }

    /** Any page can open this link. It fills the form in, and changes nothing until a tap. */
    @Test fun aSetupLinkShowsTheServerAndWaitsForATap() {
        val prefs = ctx.getSharedPreferences("promptly", android.content.Context.MODE_PRIVATE)
        val before = prefs.getString("server", null)
        try {
            prefs.edit().putString("server", "https://mine.example").commit()
            Harness.shell("am start -a android.intent.action.VIEW -d promptlyapp://setup?server=https://evil.example")
            waitFor(By.textContains("wants this phone to use https://evil.example"), 15_000)
            Thread.sleep(1000)
            assertEquals("https://mine.example", prefs.getString("server", null))
            waitFor(By.text(java.util.regex.Pattern.compile("(?i)not my server"))).click()
            Thread.sleep(800)
            assertEquals("https://mine.example", prefs.getString("server", null))
        } finally {
            prefs.edit().putString("server", before).commit()
        }
    }

    @Test fun aRepromptItemsCodeWaitsForTheMasterPassword() {
        val client = Harness.seedOffline()
        client.saveNew(client.personalVaultId(), newBody("login", "Guarded").withTotp(org.promptly.sync.passwords.core.TotpConfig("JBSWY3DPEHPK3PXP")).withFlag("reprompt", true))
        client.saveNew(client.personalVaultId(), newBody("login", "Open").withTotp(org.promptly.sync.passwords.core.TotpConfig("JBSWY3DPEHPK3PXP")))
        open()
        tap("tab-codes", 30_000)
        waitFor(By.res("code-Open"))
        waitFor(By.res("code-reveal-Guarded"))
        assertFalse(has(By.res("code-Guarded"), 300))
        tap("code-reveal-Guarded")
        fill("confirm-password", Harness.MASTER)
        tap("confirm")
        waitFor(By.res("code-Guarded"), 20_000)
    }

    /** Password-style keyboards that don't learn, on the secrets that are shown as typed. */
    @Test fun secretFieldsAskTheKeyboardNotToLearn() {
        val client = Harness.seedOffline()
        client.saveNew(client.personalVaultId(), newBody("login", "To edit").withText("password", "pw-Edit-1!"))
        open()
        tap("item-To edit", 30_000)
        tap("edit")
        Harness.scrollTap("edit-totp")
        Thread.sleep(800)
        val noLearning = 0x1000000
        val dump = Harness.shell("dumpsys input_method")
        val options = Regex("imeOptions=0x([0-9a-fA-F]+)").findAll(dump).map { it.groupValues[1].toLong(16).toInt() }.toList()
        Harness.note("imeOptions in dumpsys: ${options.joinToString { Integer.toHexString(it) }}")
        assertTrue("No field asked the keyboard not to learn: $options", options.any { it and noLearning != 0 })
        val inputTypes = Regex("inputType=0x([0-9a-fA-F]+)").findAll(dump).map { it.groupValues[1].toInt(16) }.toList()
        assertTrue("Not a password-style field: $inputTypes", inputTypes.any { it and 0xFF0 == android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD })
    }

    @Test fun notesAndCustomFieldsCopyAsSecrets() {
        val client = Harness.seedOffline()
        client.saveNew(client.personalVaultId(), newBody("note", "A note").withText("notes", "pw-Note-1!"))
        open()
        tap("item-A note", 30_000)
        tap("detail-notes-copy")
        Thread.sleep(500)
        val clip = ctx.getSystemService(android.content.ClipboardManager::class.java).primaryClipDescription
        assertTrue(clip?.extras?.getBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE) == true)
    }

    @Test fun assetLinkAnswersDontSitInTheClear() {
        Pw.init(ctx)
        val prefs = Pw.prefs.prefs
        prefs.edit().putString("dal|com.x|CERT|vault-domain.example", "1|1").commit()
        org.promptly.sync.passwords.autofill.AssetLinks.forgetMemory()
        // Nothing listens on this host, so the answer is whatever's kept: nothing, here.
        org.promptly.sync.passwords.autofill.AssetLinks.cached("com.x", "CERT", "vault-domain.example")
        val text = prefs.all.entries.joinToString { "${it.key}=${it.value}" }
        assertFalse(text, text.contains("vault-domain.example"))
    }

    @Test fun updatesGoOnlyToTheSystemInstaller() {
        val pkg = org.promptly.sync.Updater.installerPackage(ctx)
        Harness.note("Installer: $pkg")
        assertTrue("$pkg", pkg != null && pkg.contains("packageinstaller"))
    }

    @Test fun rotatedOutSaysSoAndRejoins() {
        val args = InstrumentationRegistry.getArguments()
        val bearer = args.getString("pwBearer3")
        val server = args.getString("pwServer") ?: "http://10.0.2.2:8092"
        assumeTrue("No -e pwBearer3", !bearer.isNullOrEmpty())
        Harness.clearScreen()
        runCatching { Pw.forgetDevice() }
        val t = Harness.retrying429 { VaultApi(server, { null }).registerDevice("Bearer $bearer", "Rotation test") }
        Pw.connect(server, t.token, t.deviceId)
        val client = Pw.client()!!
        val old = Harness.retrying429 { client.setup(Harness.MASTER, org.promptly.sync.passwords.core.calibrateKdf(900L)) }
        val item = client.saveNew(client.personalVaultId(), newBody("login", "Survives").withText("password", "pw-Survives-1!"))
        client.sync()
        client.lock()
        val elsewhere = VaultClient(VaultApi(server, { bearer }), MemoryStore(), MemoryKeeper())
        elsewhere.unlock(Harness.MASTER, old)
        val fresh = elsewhere.rotateSecretKey(Harness.MASTER)
        open()
        fill("master-password", Harness.MASTER)
        tap("unlock")
        waitFor(By.textContains("changed on another device"), 40_000)
        tap("rejoin")
        tap("join-kit", 30_000)
        fill("secret-key", SecretKeys.encode(fresh))
        fill("master-password", Harness.MASTER)
        tap("kit-unlock")
        waitFor(By.res("search"), 60_000)
        assertEquals("pw-Survives-1!", Pw.client()!!.get(item.id)!!.body.password)
        Harness.note("STORY-DONE rotated-out story reached its last line")
    }

    /** One long story on the real stack: sharing, fill-only, changed keys, Send, emergency
     *  access, alerts and attachments, each through the screen a person would use. */
    @Test fun sharingSendEmergencyAlertsAndAttachmentsOnTheRealStack() {
        val args = InstrumentationRegistry.getArguments()
        val bearer = args.getString("pwBearer")
        val otherBearer = args.getString("pwBearer2")
        val otherName = args.getString("pwUser2")
        val server = args.getString("pwServer") ?: "http://10.0.2.2:8092"
        assumeTrue("No -e pwBearer2", !bearer.isNullOrEmpty() && !otherBearer.isNullOrEmpty() && !otherName.isNullOrEmpty())
        Harness.clearScreen()
        runCatching { Pw.forgetDevice() }
        val t = Harness.retrying429 { VaultApi(server, { null }).registerDevice("Bearer $bearer", "Sharing test") }
        Pw.connect(server, t.token, t.deviceId)
        val client = Pw.client()!!
        val alreadyHasVault = Harness.retrying429 { client.api.prelogin() }.exists
        assumeTrue("Needs a fresh user: this script run already used it", !alreadyHasVault)
        val secret = Harness.retrying429 { client.setup(Harness.MASTER, org.promptly.sync.passwords.core.calibrateKdf(900L)) }
        Harness.note("Secret Key size ${secret.size}")
        val other = VaultClient(VaultApi(server, { otherBearer }), MemoryStore(), MemoryKeeper())
        val otherKey = runCatching { Harness.retrying429 { other.setup(Harness.MASTER) } }.getOrNull()
        assumeTrue("Needs a fresh second user", otherKey != null)
        val otherId = other.userId!!

        // Make a vault here and invite them, fill only.
        open()
        tap("tab-more", 30_000)
        tap("open-shared")
        tap("new-vault")
        fill("new-vault-name", "Our vault")
        tap("new-vault-create")
        waitFor(By.res("vault-Our vault"), 30_000)
        val myItem = client.saveNew(client.vaults().first { it.displayName == "Our vault" }.vault.id, newBody("login", "In our vault").withUrls(listOf(LoginUrl("https://ours.example"))).withText("username", "both").withText("password", "pw-Ours-1!"))
        client.sync()
        tap("add-person")
        waitFor(By.text(otherName!!)).click()
        tap("add-role")
        waitFor(By.textContains("fill only")).click()
        tap("invite-person")
        waitFor(By.textContains("$otherName (invited)"), 20_000)
        // Their safety words on this screen are the ones their device shows.
        tap("member-words-$otherName")
        waitFor(By.textContains(other.myIdentityWords().joinToString(" ")), 15_000)
        waitFor(By.text("They match")).click()

        other.sync()
        // To them it's only an invitation from someone they haven't accepted: no name, no items.
        val ourVault = other.store.getVaults().first { it.grantedBy == client.userId }
        assertEquals("fill", ourVault.role)
        assertEquals("(can't open)", other.vaults().first { it.vault.id == ourVault.id }.displayName)
        assertNull(other.get(myItem.id))
        other.acceptVault(ourVault.id)
        assertEquals("pw-Ours-1!", other.get(myItem.id)!!.body.password)
        assertFalse(other.canReveal(ourVault.id))

        // Remove them: rotation, and the list of passwords to change.
        tap("member-remove-$otherName")
        // Who gets the new key, shown before it goes.
        waitFor(By.text("Only you will have the new key."), 15_000)
        waitFor(By.text("Remove them")).click()
        waitFor(By.res("change-In our vault"), 40_000)
        other.sync()
        assertTrue(other.vaults().none { it.vault.id == ourVault.id })
        assertEquals("pw-Ours-1!", client.get(myItem.id)!!.body.password)

        // An invitation arrives, as fill only, and a local notification says so.
        val theirVault = other.createSharedVault("Their vault")
        val theirItem = other.saveNew(theirVault, newBody("login", "Fill only login").withText("username", "fill-user").withText("password", "pw-Fill-1!").withTotp(org.promptly.sync.passwords.core.TotpConfig("JBSWY3DPEHPK3PXP")).withText("notes", "visible note"))
        other.sync()
        other.addMember(theirVault, client.userId!!, "fill")
        // Seen as a count with no vault session.
        assertTrue(AlertsCheck.run(ctx))
        device.openNotification()
        waitFor(By.text("A shared vault is waiting"), 10_000)
        device.pressBack()

        device.pressBack()
        tap("open-shared", 20_000)
        // Who it's from and their words show before anything's trusted; the name doesn't yet.
        waitFor(By.res("invite-$otherName"), 30_000)
        assertTrue(waitFor(By.res("invite-words")).text.contains(other.myIdentityWords().joinToString(" ")))
        tap("invite-accept")
        waitFor(By.res("vault-Their vault"), 30_000)
        device.pressBack()
        tap("tab-items")
        tap("item-Fill only login", 30_000)
        waitFor(By.res("fill-only-note"))
        assertEquals("fill-user", device.findObject(By.res("detail-username")).text)
        assertFalse("A password row on a fill-only item", has(By.res("detail-password"), 500))
        assertFalse(has(By.res("detail-totp"), 300))
        assertFalse(has(By.res("edit"), 300))
        assertFalse(has(By.res("history"), 300))
        assertEquals(theirItem.id, client.get(theirItem.id)!!.id)
        tap("back")

        // Their key changes: only that vault shuts, and it asks.
        val trust = HashMap(client.trustEntries())
        val known = trust.getValue(otherId)
        Pw.db.setMeta("trust", kotlinx.serialization.json.JsonObject(mapOf(otherId to kotlinx.serialization.json.buildJsonObject {
            put("x25519", kotlinx.serialization.json.JsonPrimitive(known.x25519))
            put("ed25519", kotlinx.serialization.json.JsonPrimitive(org.promptly.sync.passwords.core.b64u(org.promptly.sync.passwords.core.randomBytes(32))))
            put("firstSeen", kotlinx.serialization.json.JsonPrimitive(known.firstSeen))
        })))
        tap("tab-more")
        tap("lock-now")
        fill("master-password", Harness.MASTER)
        tap("unlock")
        waitFor(By.res("search"), 60_000)
        assertTrue(client.unlocked)
        assertEquals("pw-Ours-1!", client.get(myItem.id)!!.body.password)
        assertNull("The shut vault's items stay shut", client.get(theirItem.id))
        assertTrue(theirVault in client.keyChanges)
        tap("tab-more")
        tap("open-shared")
        waitFor(By.textContains("aren't the ones you saw before"), 30_000)
        Harness.scrollTap("key-accept")
        val until = System.currentTimeMillis() + 20_000
        while (client.get(theirItem.id) == null && System.currentTimeMillis() < until) Thread.sleep(300)
        assertEquals("pw-Fill-1!", client.get(theirItem.id)!!.body.password)
        device.pressBack()

        // Decline a second invitation.
        val declined = other.createSharedVault("Not for me")
        other.addMember(declined, client.userId!!, "view")
        tap("open-shared", 20_000)
        waitFor(By.res("invite-$otherName"), 30_000)
        tap("invite-decline")
        val gone = System.currentTimeMillis() + 20_000
        while (client.store.getVaults().any { it.id == declined } && System.currentTimeMillis() < gone) Thread.sleep(300)
        assertTrue(client.store.getVaults().none { it.id == declined })
        device.pressBack()

        // A Secure Send, made here, and the link copied.
        tap("open-sends", 20_000)
        fill("send-title", "For a friend")
        fill("send-text", "the wifi is pw-Send-1!")
        Harness.scrollTap("send-create")
        val link = waitFor(By.res("send-link"), 30_000).text
        assertTrue(link, link.startsWith("$server/passwords/send/") && link.contains("#"))
        assertFalse("The key never goes to the server in the path", link.substringBefore('#').contains(link.substringAfter('#')))
        tap("send-copy")
        waitFor(By.res("send-row"), 15_000)
        device.pressBack()

        // Emergency: they ask for this vault; a phone is where you'd be when it comes.
        client.emergencyInvite(otherId, 1)
        val row = other.api.emergencyList().first { it.grantorId == client.userId }
        other.api.emergencyAct(row.id, "accept")
        client.sync()
        other.api.emergencyAct(row.id, "request")
        assertTrue(AlertsCheck.run(ctx))
        device.openNotification()
        waitFor(By.text("Emergency access needs you"), 10_000)
        device.pressBack()
        tap("open-emergency", 20_000)
        assertTrue(waitFor(By.res("emergency-state"), 30_000).text.startsWith("Asked."))
        tap("emergency-refuse")
        waitFor(By.textContains("was refused"), 20_000)
        assertEquals("refused", client.api.emergencyList().first { it.id == row.id }.state)
        device.pressBack()

        // A new device asking is one more alert.
        val joining = VaultClient(VaultApi(server, { bearer }), MemoryStore(), MemoryKeeper())
        Harness.retrying429 { joining.requestDevice("Another phone") }
        // This one with the vault locked, through WorkManager and the real worker.
        val works = androidx.work.WorkManager.getInstance(ctx).getWorkInfosForUniqueWork("pw-alerts").get()
        assertTrue("Alert check not scheduled: $works", works.any { it.state == androidx.work.WorkInfo.State.ENQUEUED })
        Pw.lock()
        // WorkManager won't run a periodic job ahead of its time, so the real worker goes through
        // it once as a one-off.
        androidx.work.WorkManager.getInstance(ctx).enqueue(androidx.work.OneTimeWorkRequestBuilder<AlertsWorker>().build())
        device.openNotification()
        waitFor(By.text("A new device wants your vault"), 45_000)
        device.pressBack()
        assertFalse(client.unlocked)
        fill("master-password", Harness.MASTER)
        Harness.tapThrough("unlock", By.res("search"))

        // Attachments through the system picker: add, read on screen, delete.
        val name = "pwtest-attachment-${System.currentTimeMillis()}.txt"
        fileInDownloads(name, "attachment body pw-Attach-1!")
        tap("tab-items")
        tap("item-In our vault", 30_000)
        Harness.scrollTap("attachment-add")
        pickFromSystem(name)
        waitFor(By.res("attachment-$name"), 40_000)
        assertEquals(name, client.get(myItem.id)!!.body.attachments.single().name)
        Harness.scrollTap("attachment-open")
        assertEquals("attachment body pw-Attach-1!", waitFor(By.res("attachment-text"), 30_000).text)
        tap("attachment-close")
        Harness.scrollTap("attachment-delete")
        val end = System.currentTimeMillis() + 20_000
        while (client.get(myItem.id)!!.body.attachments.isNotEmpty() && System.currentTimeMillis() < end) Thread.sleep(300)
        assertTrue(client.get(myItem.id)!!.body.attachments.isEmpty())

        // Travel mode: a vault comes off this phone, and back with the master password.
        tap("back")
        tap("tab-more")
        Harness.scrollTap("open-settings")
        Harness.scrollTap("travel-hide-Our vault")
        waitFor(By.res("travel-hidden"), 30_000)
        assertNull(client.get(myItem.id))
        assertTrue(client.store.getItems(client.vaults().first { it.displayName == "Our vault" }.vault.id).isEmpty())
        Harness.scrollTap("travel-password")
        fill("travel-password", Harness.MASTER)
        Harness.scrollTap("travel-end")
        val back = System.currentTimeMillis() + 30_000
        while (client.get(myItem.id) == null && System.currentTimeMillis() < back) Thread.sleep(300)
        assertEquals("pw-Ours-1!", client.get(myItem.id)!!.body.password)
        Harness.note("STORY-DONE sharing story reached its last line")
    }
}
