package org.promptly.sync.passwords

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.promptly.sync.passwords.core.Generator
import org.promptly.sync.passwords.core.Match
import org.promptly.sync.passwords.core.Wordlist
import java.io.File

/** The web client's own data files, by relative path: no copies in the Android tree. */
object Fixtures {
    val frontend: File by lazy {
        val prop = System.getProperty("pw.frontend")
        val start = if (!prop.isNullOrEmpty()) File(prop) else generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "frontend") }.first { it.isDirectory }
        check(start.isDirectory) { "No frontend directory at $start" }
        start
    }
    val core: File get() = File(frontend, "src/passwords/core")

    fun vectors(): JsonObject = Json.parseToJsonElement(File(core, "vectors.json").readText()) as JsonObject

    fun setup() {
        Wordlist.loader = { File(core, "eff_large_wordlist.json").readText() }
        Generator.rulesLoader = { File(core, "data/password-rules.json").readText() }
        org.promptly.sync.passwords.core.PasswordChange.urlsLoader = { File(core, "data/change-password-URLs.json").readText() }
        Match.loadSharedCredentials(File(core, "data/shared-credentials.json").readText())
    }
}
