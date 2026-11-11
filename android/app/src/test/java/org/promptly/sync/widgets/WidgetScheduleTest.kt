package org.promptly.sync.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Notes phase 2 (N2.7): fresher widgets. Every 15 minutes while charging,
 *  scheduled and cancelled with the 30-minute refresh; a refresh a few seconds
 *  after any Promptly notification, and nothing at all without widgets. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WidgetScheduleTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private lateinit var wm: WorkManager

    @Before
    fun setUp() {
        WorkManagerTestInitHelper.initializeTestWorkManager(
            ctx, Configuration.Builder().setExecutor(SynchronousExecutor()).setMinimumLoggingLevel(android.util.Log.ERROR).build(),
        )
        wm = WorkManager.getInstance(ctx)
        WidgetsOff.set(ctx, false)
    }

    private fun place() {
        val info = AppWidgetProviderInfo().apply { provider = ComponentName(ctx, TasksWidgetReceiver::class.java) }
        shadowOf(AppWidgetManager.getInstance(ctx)).addBoundWidget(7, info)
    }

    private fun unique(name: String): List<WorkInfo> = wm.getWorkInfosForUniqueWork(name).get()

    private fun live(name: String) = unique(name).filter { !it.state.isFinished }

    @Test
    fun chargingRefreshComesAndGoesWithTheWidgets() {
        WidgetSync.periodic(ctx)
        val charging = live(WidgetSync.CHARGING)
        assertEquals(1, charging.size)
        assertTrue(charging[0].constraints.requiresCharging())
        assertEquals(1, live("widgets-refresh").size)
        // Asked again (every app start): still one of each.
        WidgetSync.periodic(ctx)
        assertEquals(1, live(WidgetSync.CHARGING).size)

        WidgetSync.cancel(ctx)
        assertTrue(live(WidgetSync.CHARGING).isEmpty())
        assertTrue(live("widgets-refresh").isEmpty())
    }

    @Test
    fun aNotificationWithNoWidgetsDoesNothing() {
        assertFalse(Widgets.placed(ctx))
        assertFalse(WidgetSync.notified(ctx))
        WidgetEvents().onReceive(ctx, Intent(WidgetEvents.ACTION_NOTIFIED))
        assertTrue(live("widgets-now").isEmpty())
    }

    @Test
    fun aNotificationRefreshesTheWidgetsSoon() {
        place()
        assertTrue(Widgets.placed(ctx))
        WidgetEvents().onReceive(ctx, Intent(WidgetEvents.ACTION_NOTIFIED))
        val now = live("widgets-now")
        assertEquals(1, now.size)
        assertEquals(WorkInfo.State.ENQUEUED, now[0].state)
        assertTrue(now[0].initialDelayMillis in 1..WidgetSync.AFTER_NOTIFICATION_MS)
    }

    @Test
    fun widgetsTurnedOffForThisPhoneMeansNoRefresh() {
        place()
        WidgetsOff.set(ctx, true)
        assertFalse(WidgetSync.notified(ctx))
        assertTrue(live("widgets-now").isEmpty())
    }
}
