package org.promptly.sync.widgets

import android.content.Context
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.glance.appwidget.testing.unit.runGlanceAppWidgetUnitTest
import androidx.glance.testing.unit.hasContentDescription
import androidx.glance.testing.unit.hasText
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.LocalDate

/** The at-a-glance widgets (1.9.0): what each shows from a saved answer,
 *  the countdown's arithmetic, and the sync asking for only the sections
 *  the widgets on the home screen need. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GlanceWidgetsTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val now = System.currentTimeMillis()

    private fun hub(json: String) = HubState(JSONObject(json), now, null, 1)

    @Before
    fun clean() = runBlocking {
        HubStore.wipe(ctx)
        WidgetStore.wipe(ctx)
        WidgetsOff.set(ctx, false)
    }

    @Test
    fun today_shows_whats_next_and_when_to_leave() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(DpSize(320.dp, 200.dp))
        val h = hub(
            """{"today": {"greeting": "Good morning, Ann", "weather": "Sunny, 31 degrees.", "tasks_due": 3, "tasks_overdue": 1,
                "birthdays": ["Sam"], "next": {"title": "Dentist", "time": "11:00 am", "leave_by": "10:37 am", "minutes": 18}}}""",
        )
        provideComposable { TodayWidget().Body(h, emptyPreferences(), now) }
        onNode(hasText("Good morning, Ann")).assertExists()
        onNode(hasText("11:00 am  Dentist")).assertExists()
        onNode(hasText("Leave by 10:37 am · 18 min drive")).assertExists()
        onNode(hasText("3 tasks due · 1 overdue")).assertExists()
        onNode(hasContentDescription("Read me my day")).assertExists()
    }

    @Test
    fun macros_says_whats_left_and_whats_over() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(DpSize(250.dp, 180.dp))
        val h = hub("""{"macros": {"kcal": 1523, "kcal_target": 3110, "protein": 200, "protein_target": 184, "url": "/apps/meals/m", "ask_url": "/apps/meals/m?tab=ask"}}""")
        provideComposable { MacrosWidget().Body(h, emptyPreferences(), now) }
        onNode(hasText("1,587 kcal left")).assertExists()
        onNode(hasText("16 g protein over")).assertExists()
        onNode(hasContentDescription("Log food")).assertExists()
    }

    @Test
    fun macros_with_no_numbers_says_how_to_get_them() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        provideComposable { MacrosWidget().Body(HubState(JSONObject(), now, null, 1), emptyPreferences(), now) }
        onNode(hasText("Set your targets in P Macros to see what's left today.")).assertExists()
    }

    @Test
    fun mail_shows_the_count_and_who_from() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(DpSize(250.dp, 200.dp))
        val h = hub("""{"mail": {"unread": 4, "items": [{"from": "School office", "subject": "Excursion form", "url": "/mail?open=a/t"}]}}""")
        provideComposable { MailWidget().Body(h, emptyPreferences(), now) }
        onNode(hasText("4")).assertExists()
        onNode(hasText("School office")).assertExists()
        onNode(hasText("Excursion form")).assertExists()
    }

    @Test
    fun on_their_way_counts_down_from_the_arrival_time() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        setAppWidgetSize(DpSize(250.dp, 180.dp))
        val eta = java.time.Instant.ofEpochMilli(now + 12 * 60_000).toString()
        val h = hub("""{"trips": [{"user_id": "u1", "name": "Bob", "destination": "Home", "eta": "$eta"}]}""")
        provideComposable { OnTheWayWidget().Body(h, emptyPreferences(), now) }
        onNode(hasText("Bob → Home")).assertExists()
    }

    @Test
    fun on_their_way_when_nobody_is() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        provideComposable { OnTheWayWidget().Body(HubState(JSONObject(), now, null, 1), emptyPreferences(), now) }
        onNode(hasText("Nobody's on their way right now. When someone shares a trip with you, it shows here.")).assertExists()
    }

    @Test
    fun countdown_counts_to_a_day_and_to_next_years_birthday() {
        val today = LocalDate.of(2026, 11, 12)
        assertEquals(10L, CountdownWidget.daysUntil(CountdownWidget.Config("Holiday", LocalDate.of(2026, 11, 22), false), today))
        assertEquals(-2L, CountdownWidget.daysUntil(CountdownWidget.Config("Party", LocalDate.of(2026, 11, 10), false), today))
        // A birthday that's been this year counts to next year's.
        assertEquals(363L, CountdownWidget.daysUntil(CountdownWidget.Config("Sam", LocalDate.of(1990, 11, 10), true), today))
        assertEquals(0L, CountdownWidget.daysUntil(CountdownWidget.Config("Sam", LocalDate.of(1990, 11, 12), true), today))
        // 29 February in a year without one: the 28th.
        assertEquals(LocalDate.of(2027, 2, 28).toEpochDay() - today.toEpochDay(), CountdownWidget.daysUntil(CountdownWidget.Config("Leap", LocalDate.of(2000, 2, 29), true), today))
    }

    @Test
    fun countdown_with_no_day_asks_for_one() = runGlanceAppWidgetUnitTest {
        setContext(ctx)
        provideComposable { CountdownWidget().Body(HubState(), emptyPreferences(), now) }
        onNode(hasText("Tap to choose a day")).assertExists()
    }

    @Test
    fun people_only_keeps_ids_that_look_like_ids() {
        val good = "3f2b1c4d-1111-4222-8333-444455556666"
        val prefs = mutablePreferencesOf(
            PeopleWidget.PEOPLE to JSONArray()
                .put(JSONObject().put("user_id", good).put("name", "Sam Lee"))
                .put(JSONObject().put("user_id", "../evil").put("name", "Nope")).toString(),
        )
        assertEquals(listOf(good), PeopleWidget.peopleOf(prefs).map { it.optString("user_id") })
        assertEquals("SL", initials("Sam Lee"))
        assertEquals("M", initials("mum"))
    }

    @Test
    fun the_panel_starts_with_the_everyday_apps_and_knows_every_app() {
        assertEquals(PanelApps.DEFAULT, PanelApps.keys(emptyPreferences()))
        val keys = PanelApps.all(ctx).map { it.key }
        assertTrue("promptly" in keys && "rooms" in keys && "meals" in keys)
        assertEquals("/rooms/", PanelApps.byKey(ctx)["rooms"]!!.path)
    }

    @Test
    fun minutes_until_and_labels() {
        assertEquals(12L, minutesUntil(java.time.Instant.ofEpochMilli(now + 12 * 60_000).toString(), now))
        assertNull(minutesUntil("not a time", now))
        assertEquals("1 h 20 min", minutesLabel(80))
        assertEquals("45 min", minutesLabel(45))
    }

    /** A stand-in server that records which glance sections it was asked for. */
    private class Fake : WidgetBackend {
        var asked: List<String>? = null
        var snapshots = 0
        override fun snapshot(want: List<String>, days: Int, someday: Boolean, etags: Map<String, String>, noteIds: List<String>): JSONObject {
            snapshots++
            return JSONObject()
        }
        override fun send(op: Op): JSONObject = JSONObject()
        override fun glance(want: List<String>): JSONObject {
            asked = want
            return JSONObject().put("today", JSONObject().put("greeting", "Hi")).put("counts", JSONObject().put("rooms", 2))
        }
    }

    @Test
    fun sync_asks_for_the_glance_sections_and_keeps_old_ones() = runBlocking {
        val api = Fake()
        HubStore.save(ctx, JSONObject().put("mail", JSONObject().put("unread", 3)), 500, null)
        assertEquals(SyncLogic.Outcome.OK, SyncLogic.run(ctx, api, emptyList(), 1000, hub = listOf("today", "counts")))
        assertEquals(listOf("today", "counts"), api.asked)
        assertEquals(0, api.snapshots) // no Agenda/Tasks/Notes widget: no snapshot call
        val s = HubStore.state.value
        assertEquals("Hi", s.section("today")!!.text("greeting"))
        assertEquals(3, s.section("mail")!!.optInt("unread"))
        assertEquals(1000L, s.fetchedAt)
    }

    @Test
    fun no_glance_widgets_no_glance_call() = runBlocking {
        val api = Fake()
        SyncLogic.run(ctx, api, emptyList(), 1000)
        assertNull(api.asked)
    }
}
