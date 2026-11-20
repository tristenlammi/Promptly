package org.promptly.sync.widgets

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.emptyPreferences
import androidx.glance.appwidget.testing.unit.runGlanceAppWidgetUnitTest
import androidx.glance.testing.unit.hasContentDescription
import androidx.glance.testing.unit.hasText
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Study widget: what's due today and the next lesson, from a saved answer
 *  of `/api/widgets/glance`; and that it is a widget of its own. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StudyWidgetTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val now = System.currentTimeMillis()

    private fun hub(json: String) = HubState(JSONObject(json), now, null, 1)

    @Test
    fun the_words_for_what_is_due_and_the_run_of_days() {
        assertEquals("Nothing to review today", StudyWords.due(0))
        assertEquals("1 idea to review", StudyWords.due(1))
        assertEquals("12 ideas to review", StudyWords.due(12))
        assertEquals("4 days in a row", StudyWords.streak(4, false))
        assertEquals("Studied today", StudyWords.streak(1, true))
        // A run that ended isn't mentioned: nothing to nag about.
        assertNull(StudyWords.streak(0, false))
        assertNull(StudyWords.streak(1, false))
    }

    @Test
    fun the_button_is_reviews_first_then_the_next_lesson_then_study_itself() {
        val both = JSONObject("""{"due": 3, "review_url": "/study/review", "next_url": "/study/abc/continue", "url": "/study"}""")
        assertEquals("Review" to "/study/review", StudyWords.action(both))
        val lesson = JSONObject("""{"due": 0, "review_url": null, "next_url": "/study/abc/continue", "url": "/study"}""")
        assertEquals("Next lesson" to "/study/abc/continue", StudyWords.action(lesson))
        assertEquals("Open Study" to "/study", StudyWords.action(JSONObject("""{"due": 0}""")))
        // "Due" with nowhere to review them (an old server): never a dead button.
        assertEquals("Next lesson" to "/study/abc/continue", StudyWords.action(JSONObject("""{"due": 2, "next_url": "/study/abc/continue"}""")))
    }

    @Test
    fun shows_what_is_due_the_subject_and_what_comes_next() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(DpSize(250.dp, 200.dp))
        val h = hub(
            """{"study": {"due": 3, "subject": "How tides work", "percent": 40, "next": "Spring tides", "next_url": "/study/abc/continue",
                "review_url": "/study/review", "streak": 4, "today": false, "url": "/study"}}""",
        )
        provideComposable { StudyWidget().Body(h, emptyPreferences(), now) }
        onNode(hasText("3 ideas to review")).assertExists()
        onNode(hasText("How tides work")).assertExists()
        onNode(hasText("Next: Spring tides")).assertExists()
        onNode(hasText("4 days in a row")).assertExists()
        onNode(hasContentDescription("Review")).assertExists()
    }

    @Test
    fun nothing_due_offers_the_next_lesson() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(DpSize(250.dp, 120.dp))
        val h = hub("""{"study": {"due": 0, "subject": "How tides work", "next": "Spring tides", "next_url": "/study/abc/continue", "review_url": null, "streak": 0, "today": false, "url": "/study"}}""")
        provideComposable { StudyWidget().Body(h, emptyPreferences(), now) }
        onNode(hasText("Nothing to review today")).assertExists()
        onNode(hasContentDescription("Next lesson")).assertExists()
    }

    @Test
    fun with_no_subject_says_how_to_get_one() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        provideComposable { StudyWidget().Body(HubState(JSONObject(), now, null, 1), emptyPreferences(), now) }
        onNode(hasText("Start a subject in P Study and what's due shows here.")).assertExists()
    }

    @Test
    fun it_is_a_widget_of_its_own_that_asks_only_for_its_own_section() {
        val kind = Widgets.ALL.single { it.receiver == StudyWidgetReceiver::class.java }
        assertEquals(listOf("study"), kind.hub)
        assertTrue(kind.needs.isEmpty())
        // Glance tells widgets apart by the GlanceAppWidget's class name: every kind has its own.
        val names = Widgets.ALL.map { it.widget().javaClass.name }
        assertEquals(names.size, names.toSet().size)
        assertNotEquals(MailWidget::class.java.name, StudyWidget::class.java.name)
        // Declared in the manifest, with its picker entry.
        val info = ctx.packageManager.getReceiverInfo(ComponentName(ctx, StudyWidgetReceiver::class.java), PackageManager.GET_META_DATA)
        assertTrue(info.exported)
        assertTrue(info.metaData.containsKey("android.appwidget.provider"))
    }

    @Test
    fun its_taps_open_pages_of_p_study() {
        val i = Open.page(ctx, Open.STUDY, "/study/review")
        assertEquals("org.promptly.app.StudyLauncher", i.getStringExtra(Open.EXTRA_LAUNCHER))
        assertEquals("/study/review", i.getStringExtra(Open.EXTRA_PATH))
    }
}
