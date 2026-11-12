package org.promptly.sync.widgets

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * In 1.9.0 the release build (R8) merged the new widget classes into one. Glance
 * tells widgets apart by their class name, so refreshing the App panel redrew
 * Meals & Macros as an App panel. These guard both halves of the fix.
 */
class WidgetIdentityTest {
    private fun moduleFile(path: String): File =
        listOf(File(path), File("app/$path")).first { it.exists() }

    @Test
    fun `the shrinker keeps every widget its own class`() {
        val rules = moduleFile("proguard-rules.pro").readText()
        assertTrue(
            "proguard-rules.pro must keep GlanceAppWidget subclasses (no merging, no renaming)",
            rules.contains("-keep class org.promptly.sync.widgets.** extends androidx.glance.appwidget.GlanceAppWidget"),
        )
    }

    @Test
    fun `every kind draws with its own widget class`() {
        val classes = Widgets.ALL.map { it.widget()::class.java.name }
        assertEquals("two kinds share a widget class", classes.size, classes.toSet().size)
        val receivers = Widgets.ALL.map { it.receiver.name }
        assertEquals("two kinds share a receiver", receivers.size, receivers.toSet().size)
    }

    @Test
    fun `refreshes never look widgets up by class name`() {
        val dir = moduleFile("src/main/java/org/promptly/sync/widgets")
        val offenders = dir.listFiles()!!.filter { it.extension == "kt" }.filter { f ->
            f.readLines().any { line ->
                val code = line.substringBefore("//").trim()
                !code.startsWith("*") && (code.contains(".updateAll(") || code.contains("getGlanceIds("))
            }
        }.map { it.name }
        assertEquals("use Widgets.glanceIds / redrawKind instead", emptyList<String>(), offenders)
    }

    @Test
    fun `every widget has a settings screen with its background choice`() {
        val xml = moduleFile("src/main/res/xml")
        val infos = xml.listFiles()!!.filter { it.name.startsWith("wg_") && it.name.endsWith("_info.xml") }
        assertTrue(infos.isNotEmpty())
        val missing = infos.filter { !it.readText().contains("android:configure=") }.map { it.name }
        assertEquals(emptyList<String>(), missing)
    }
}
