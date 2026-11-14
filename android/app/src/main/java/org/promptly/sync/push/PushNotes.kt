package org.promptly.sync.push

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.net.Uri
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.promptly.sync.Api
import org.promptly.sync.R
import org.promptly.sync.Store
import org.promptly.sync.calls.CallCenter
import org.promptly.sync.maps.Maps
import org.promptly.sync.widgets.Open
import java.util.concurrent.TimeUnit

/** One button on a notification (`notifications/actions.py`): its signed token does the work. */
data class PushAction(val action: String, val title: String, val token: String, val text: Boolean, val placeholder: String)

/** What the server pushes: the same JSON the web app's service worker reads (`frontend/src/sw.ts`). */
data class PushPayload(
    val title: String,
    val body: String,
    val url: String?,
    val tag: String?,
    val category: String?,
    val icon: String?,
    val stack: Boolean,
    val line: String?,
    val actions: List<PushAction>,
    val kind: String?,
    val callId: String?,
    val video: Boolean,
    val busy: Boolean,
    val group: Boolean,
    val answerToken: String?,
) {
    /** A call push as the tag the calls code reads (`CallTag`, the same shape the web app builds). */
    fun callTag(): String? {
        val id = callId ?: return null
        return when (kind) {
            "call_ring" -> "call:$id|r|${if (video) "v" else "a"}|${if (busy) 1 else 0}|${if (group) 1 else 0}|${answerToken.orEmpty()}"
            "call_stop" -> "call:$id|s"
            "call_missed" -> "call:$id|m"
            else -> "call:$id"
        }
    }

    companion object {
        fun parse(text: String): PushPayload {
            val o = try {
                JSONObject(text)
            } catch (e: Exception) {
                // Not JSON: plain words.
                return PushPayload("Promptly", text.take(500), null, null, null, null, false, null, emptyList(), null, null, false, false, false, null)
            }
            fun str(k: String): String? = if (o.isNull(k)) null else o.optString(k).ifBlank { null }
            val actions = buildList {
                val arr = o.optJSONArray("actions") ?: return@buildList
                for (i in 0 until arr.length()) {
                    val a = arr.optJSONObject(i) ?: continue
                    val token = a.optString("token")
                    val name = a.optString("action")
                    if (token.isBlank() || name.isBlank()) continue
                    add(PushAction(name, a.optString("title").ifBlank { name }, token, a.optString("type") == "text", a.optString("placeholder")))
                }
            }
            return PushPayload(
                title = str("title") ?: "Promptly",
                body = str("body") ?: "",
                url = str("url"),
                tag = str("tag"),
                category = str("category"),
                icon = str("icon"),
                stack = o.optBoolean("stack", false),
                line = str("line"),
                actions = actions,
                kind = str("kind"),
                callId = str("call_id"),
                video = str("media") == "video",
                busy = o.optBoolean("busy", false),
                group = o.optBoolean("group", false),
                answerToken = str("answer_token"),
            )
        }
    }
}

/** Which of Android's notification channels a category goes in: each has its
 *  own sound and switch in the phone's settings. */
enum class PushChannel(val id: String, val label: String, val about: String, val loud: Boolean) {
    MESSAGES("push_messages", "Messages", "Rooms messages, mentions and missed calls", true),
    REMINDERS("push_reminders", "Reminders and calendar", "Reminders you set, events and invites", true),
    MAIL("push_mail", "Mail", "New mail and the daily brief", false),
    SOCIAL("push_social", "Porch and sharing", "Porch, and things shared with you", false),
    OTHER("push_other", "Everything else", "Finished exports and imports, forms, security", false);

    companion object {
        fun of(category: String?): PushChannel = when (category) {
            "room_message", "call", "mention", "talk_followup", "maps", "test" -> MESSAGES
            "item_reminder", "calendar", "assignment" -> REMINDERS
            "mail", "email_brief", "email_action" -> MAIL
            "porch", "notes", "shared_message", "invite" -> SOCIAL
            else -> OTHER
        }
    }
}

object PushNotes {
    private const val ID = 0x50757368 // "Push"
    private const val EXTRA_LINES = "promptly.lines"
    private const val EXTRA_COUNT = "promptly.count"
    private const val STACK_SHOWN = 5
    private const val ACCENT = 0xFFD97757.toInt()
    private const val WIDGET_EVENTS = "org.promptly.sync.widgets.WidgetEvents"
    private const val ACTION_NOTIFIED = "org.promptly.app.action.NOTIFIED"
    internal const val ACTION_BUTTON = "org.promptly.sync.push.BUTTON"
    internal const val KEY_REPLY = "reply"

    fun channels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        for (c in PushChannel.entries) {
            val importance = if (c.loud) NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT
            nm.createNotificationChannel(NotificationChannel(c.id, c.label, importance).apply { description = c.about })
        }
    }

    /** Which P app a page belongs to (its own icon's task), by its path. */
    fun launcherFor(path: String): String = when {
        path.startsWith("/rooms") -> Open.ROOMS
        path.startsWith("/calendar") -> Open.CALENDAR
        path.startsWith("/photos") -> Open.PHOTOS
        path.startsWith("/notes") -> Open.NOTES
        path.startsWith("/porch") -> Open.PORCH
        path.startsWith("/maps") -> Open.MAPS
        path.startsWith("/mail") -> Open.MAIL
        else -> Open.PROMPTLY
    }

    /** "https://server/rooms/x?y" or "/rooms/x?y" → "/rooms/x?y". */
    fun pathOf(url: String?): String {
        if (url.isNullOrBlank()) return "/"
        if (url.startsWith("/")) return url
        val u = Uri.parse(url)
        val path = u.encodedPath?.ifBlank { "/" } ?: "/"
        return path + (u.encodedQuery?.let { "?$it" } ?: "")
    }

    fun show(context: Context, p: PushPayload) {
        val app = context.applicationContext
        tellWidgets(app)
        if (p.category == "call" && p.callId != null) {
            val tag = p.callTag()
            val shown = tag != null && try {
                CallCenter.ring(app, tag, p.title, p.body, null)
            } catch (e: RuntimeException) {
                Log.w(NativePush.TAG, "call push", e)
                false
            }
            // A ring is the incoming-call screen; a stop shows nothing. A missed
            // call (or a ring that couldn't be one) is an ordinary notification.
            if (shown || p.kind == "call_stop") return
        }
        val nm = app.getSystemService(NotificationManager::class.java) ?: return
        if (app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            Log.i(NativePush.TAG, "notifications aren't allowed for the app: not shown")
            return
        }
        channels(app)
        val channel = PushChannel.of(p.category)
        val tag = p.tag ?: "one:${System.nanoTime()}"

        var title = p.title
        var body = p.body
        var lines = emptyList<String>()
        var count = 1
        // A room's messages stack in one notification: the newest few lines.
        if (p.stack && p.tag != null) {
            val prev = nm.activeNotifications.firstOrNull { it.tag == p.tag && it.id == ID }?.notification?.extras
            val before = prev?.getStringArray(EXTRA_LINES)?.toList().orEmpty()
            lines = (before + (p.line ?: p.body)).takeLast(STACK_SHOWN)
            count = (prev?.getInt(EXTRA_COUNT, 0) ?: 0) + 1
            if (count > 1) {
                title = "${p.title} ($count new)"
                val hidden = count - lines.size
                body = (if (hidden > 0) "+$hidden earlier\n" else "") + lines.joinToString("\n")
            }
        }

        val path = pathOf(p.url)
        val open = PendingIntent.getActivity(
            app, tag.hashCode(), Open.page(app, launcherFor(path), path),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = Notification.Builder(app, channel.id)
            .setSmallIcon(R.drawable.ic_promptly_status)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(body.lineSequence().lastOrNull().orEmpty())
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
            .setCategory(if (channel == PushChannel.MESSAGES) Notification.CATEGORY_MESSAGE else if (channel == PushChannel.REMINDERS) Notification.CATEGORY_REMINDER else Notification.CATEGORY_STATUS)
        b.extras.putStringArray(EXTRA_LINES, lines.toTypedArray())
        b.extras.putInt(EXTRA_COUNT, count)
        picture(app, p.icon)?.let { b.setLargeIcon(Icon.createWithBitmap(it)) }
        for ((i, a) in p.actions.take(3).withIndex()) b.addAction(button(app, a, tag, path, i))
        nm.notify(tag, ID, b.build())
    }

    private fun button(app: Context, a: PushAction, tag: String, path: String, index: Int): Notification.Action {
        val intent = Intent(app, PushButtonReceiver::class.java).setAction(ACTION_BUTTON)
            .setData(Uri.parse("promptly-push://button/${Uri.encode(tag)}/${Uri.encode(a.action)}"))
            .putExtra("token", a.token).putExtra("action", a.action).putExtra("tag", tag).putExtra("path", path)
        // A reply's words are added to the intent by Android, so that one can't be immutable.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (a.text) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE)
        val pi = PendingIntent.getBroadcast(app, tag.hashCode() * 31 + index, intent, flags)
        val action = Notification.Action.Builder(Icon.createWithResource(app, R.drawable.ic_promptly_status), a.title, pi)
        if (a.text) action.addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel(a.placeholder.ifBlank { a.title }).build())
        return action.build()
    }

    /** The sender's picture, if the server has one this phone may read. Never holds a push up for long. */
    private fun picture(app: Context, icon: String?): Bitmap? {
        if (icon.isNullOrBlank() || icon.endsWith("/pwa-192.png")) return null
        val server = Store(app).account?.server ?: return null
        val url = if (icon.startsWith("/")) server + icon else if (icon.startsWith(server)) icon else return null
        return try {
            Maps.client(app, 4).newCall(Request.Builder().url(url).build()).execute().use { r ->
                if (!r.isSuccessful) null else BitmapFactory.decodeStream(r.body.byteStream())
            }
        } catch (e: Exception) {
            null
        }
    }

    fun cancel(context: Context, tag: String) {
        context.getSystemService(NotificationManager::class.java)?.cancel(tag, ID)
    }

    /** As `Delegation` does for a browser's notification: the widgets refresh shortly. */
    private fun tellWidgets(app: Context) {
        try {
            app.sendBroadcast(Intent(ACTION_NOTIFIED).setClassName(app.packageName, WIDGET_EVENTS))
        } catch (e: RuntimeException) {
            // No widgets in this build.
        }
    }
}

/** A notification's button (Reply, Mark as read, Done, Snooze…): the server does
 *  it by the button's token; if it can't, the page opens instead. */
class PushButtonReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != PushNotes.ACTION_BUTTON) return
        val app = context.applicationContext
        val token = intent.getStringExtra("token") ?: return
        val action = intent.getStringExtra("action").orEmpty()
        val tag = intent.getStringExtra("tag") ?: return
        val path = intent.getStringExtra("path") ?: "/"
        val typed = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(PushNotes.KEY_REPLY)?.toString()?.trim().orEmpty()
        val pending = goAsync()
        Thread {
            try {
                val ok = (action != "room_reply" || typed.isNotEmpty()) && send(app, token, typed)
                // Done either way: the notification has served its purpose.
                PushNotes.cancel(app, tag)
                if (!ok) Open.go(app, PushNotes.launcherFor(path), path)
            } finally {
                pending.finish()
            }
        }.start()
    }

    private fun send(app: Context, token: String, text: String): Boolean {
        val server = Store(app).account?.server ?: return false
        val body = JSONObject().put("token", token)
        if (text.isNotEmpty()) body.put("text", text)
        return try {
            // The token is the permission: no sign-in is sent with it.
            val client = Api.http.newBuilder().callTimeout(8, TimeUnit.SECONDS).build()
            val req = Request.Builder().url("$server/api/notifications/action")
                .post(body.toString().toRequestBody("application/json".toMediaType())).build()
            client.newCall(req).execute().use { it.isSuccessful }
        } catch (e: Exception) {
            false
        }
    }
}
