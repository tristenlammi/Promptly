package org.promptly.sync.widgets

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.CheckBox
import androidx.glance.appwidget.CheckboxDefaults
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.state.GlanceStateDefinition
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.unit.ColorProvider as GlanceColor
import org.promptly.sync.R
import org.promptly.sync.capture.AddItemActivity
import org.promptly.sync.capture.QuickNoteActivity
import org.promptly.sync.capture.VoiceNoteActivity

/*
 * The Notes widgets (W1.3):
 *  - **Notes**: "Take a note" · list · mic, then your pinned and recent notes
 *    as cards in their colours (title and three lines, or the first items to
 *    tick). Tap a card → it opens in P Notes.
 *  - **One note**: a note or list you choose, its items to tick (ticked ones
 *    below), **+** to add one. "This note isn't available" if it's gone.
 * Both draw from the saved copy, so they work with no signal; ticks and new
 * notes show at once and are sent when there's signal.
 */

/** Note colours on the home screen: Promptly's palette, light and dark. */
object NoteTint {
    private val day = mapOf(
        "coral" to 0xFFFAAFA8, "peach" to 0xFFF39F76, "sand" to 0xFFFFF8B8, "mint" to 0xFFE2F6D3, "sage" to 0xFFB4DDD3,
        "fog" to 0xFFD4E4ED, "storm" to 0xFFAECCDC, "dusk" to 0xFFD3BFDB, "blossom" to 0xFFF6E2DD, "clay" to 0xFFE9E3D4, "chalk" to 0xFFEFEFF1,
    )
    private val night = mapOf(
        "coral" to 0xFF77172E, "peach" to 0xFF692B17, "sand" to 0xFF7C4A03, "mint" to 0xFF264D3B, "sage" to 0xFF0C625D,
        "fog" to 0xFF256377, "storm" to 0xFF284255, "dusk" to 0xFF472E5B, "blossom" to 0xFF6C394F, "clay" to 0xFF4B443A, "chalk" to 0xFF232427,
    )

    fun coloured(name: String): Boolean = name in day

    fun background(name: String): GlanceColor =
        if (!coloured(name)) WColors.surface else ColorProvider(day = Color(day.getValue(name)), night = Color(night.getValue(name)))

    fun text(name: String): GlanceColor =
        if (!coloured(name)) WColors.text else ColorProvider(day = Color(0xFF1A1A19), night = Color(0xFFF5F5F4))

    fun muted(name: String): GlanceColor =
        if (!coloured(name)) WColors.muted else ColorProvider(day = Color(0xA8000000), night = Color(0xBDFFFFFF))
}

// ------------------------------------------------------------------ Notes

class NotesWidget : GlanceAppWidget() {
    // Exact: the cards that fit this widget's real size (it never scrolls).
    override val sizeMode = SizeMode.Exact
    override val stateDefinition: GlanceStateDefinition<*> = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        WidgetStore.load(context)
        provideContent {
            val state = WidgetStore.state.collectAsState().value
            val prefs = currentState<Preferences>()
            val ctx = LocalContext.current
            val link = Widgets.link(ctx)
            if (link != Link.LINKED) LinkMessage(ctx, link)
            else NotesContent(state, configOf(prefs), System.currentTimeMillis(), clockOf(ctx), LocalSize.current)
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        provideContent { NotesContent(Samples.notes(), NotesConfig(), Samples.now(), clockOf(context), TALL) }
    }

    companion object {
        val SMALL = DpSize(110.dp, 110.dp)
        val WIDE = DpSize(250.dp, 110.dp)
        val TALL = DpSize(250.dp, 250.dp)

        val TITLES_ONLY = booleanPreferencesKey("titles_only")

        fun configOf(p: Preferences) = NotesConfig(p[TITLES_ONLY] ?: false)
    }
}

class NotesWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NotesWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Widgets.onEnabled(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        Widgets.onDisabled(context)
    }
}

fun quickNote(ctx: Context, list: Boolean): Intent =
    Intent(ctx, QuickNoteActivity::class.java)
        .putExtra(QuickNoteActivity.EXTRA_LIST, list)
        .setData(Uri.parse("promptly-widget://" + if (list) "new-list" else "new-note"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

fun voiceNote(ctx: Context): Intent =
    Intent(ctx, VoiceNoteActivity::class.java)
        .setData(Uri.parse("promptly-widget://voice-note"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

@Composable
private fun BarButton(icon: Int, label: String, action: Action, modifier: GlanceModifier = GlanceModifier) {
    Box(
        modifier.size(36.dp).background(WColors.surface).cornerRadius(18.dp).clickable(action).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Image(ImageProvider(icon), contentDescription = null, modifier = GlanceModifier.size(20.dp), colorFilter = ColorFilter.tint(WColors.accent))
    }
}

/** "Take a note" · list · mic. Narrow: three round buttons. */
@Composable
private fun CaptureBar(ctx: Context, narrow: Boolean) {
    Row(GlanceModifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        if (narrow) {
            BarButton(R.drawable.wg_note, "Take a note", actionStartActivity(quickNote(ctx, false)))
            Spacer(GlanceModifier.defaultWeight())
            BarButton(R.drawable.wg_list, "New list", actionStartActivity(quickNote(ctx, true)))
            Spacer(GlanceModifier.defaultWeight())
            BarButton(R.drawable.wg_mic, "Voice note", actionStartActivity(voiceNote(ctx)))
        } else {
            Row(
                GlanceModifier.defaultWeight().height(36.dp).background(WColors.surface).cornerRadius(18.dp).padding(horizontal = 14.dp)
                    .clickable(actionStartActivity(quickNote(ctx, false))).semantics { contentDescription = "Take a note" },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Take a note…", style = WText.style(14.sp, WColors.muted), maxLines = 1)
            }
            Spacer(GlanceModifier.width(6.dp))
            BarButton(R.drawable.wg_list, "New list", actionStartActivity(quickNote(ctx, true)))
            Spacer(GlanceModifier.width(6.dp))
            BarButton(R.drawable.wg_mic, "Voice note", actionStartActivity(voiceNote(ctx)))
        }
    }
}

@Composable
fun NotesContent(state: WidgetState, cfg: NotesConfig, now: Long, clock: Clock, size: DpSize) {
    val ctx = LocalContext.current
    val narrow = size.width < NotesWidget.WIDE.width
    val grid = !narrow && size.height >= NotesWidget.TALL.height
    val cards = NotesLogic.cards(state, now)
    val stale = staleLabel(state.snapshot.fetchedAt, now, clock)
    val notice = state.notices.lastOrNull { it.area == "notes" }
    val scale = ctx.resources.configuration.fontScale
    // What fits, whole, then "3 more notes" (no scrolling: see Fit).
    val room = size.height.value - Fit.FRAME - Fit.SPARE - (36f + 8f) - Fit.footer(notice != null, stale != null, scale)
    val inner = size.width.value - 24f
    val all = actionStartActivity(Open.page(ctx, Open.NOTES, "/notes"))
    Frame {
        CaptureBar(ctx, narrow)
        when {
            state.snapshot.notesSection == null && state.snapshot.fetchedAt == 0L && cards.isEmpty() ->
                Column(GlanceModifier.defaultWeight().fillMaxWidth()) { Muted("Getting your notes…") }
            cards.isEmpty() -> Column(GlanceModifier.defaultWeight().fillMaxWidth().clickable(actionStartActivity(Open.page(ctx, Open.NOTES, "/notes")))) {
                Text("No notes yet", style = WText.style(13.sp, bold = true), maxLines = 1)
                Muted(if (narrow) "Tap ✎ to write one." else "Take a note, start a list, or tap the mic for a voice note.", size = 12.sp)
            }
            // Two columns, a row at a time: a home-screen grid gives every cell the
            // first card's height, so cards of different heights overlapped.
            !narrow -> {
                val lines = if (grid) 4 else 3
                val rows = cards.chunked(2)
                val cardW = (inner - 6f) / 2
                fun fits(c: NotesConfig) = Fit.count(rows.map { r -> r.maxOf { noteCardHeight(it, c, cardW, lines, 4, scale) } + 6f }, room, Fit.more(scale))
                // Not even one row whole: titles only, so some still show.
                val look = if (fits(cfg) == 0) cfg.copy(titlesOnly = true) else cfg
                val n = fits(look)
                Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                    for (row in rows.take(n)) {
                        Row(GlanceModifier.fillMaxWidth().padding(vertical = 3.dp)) {
                            Box(GlanceModifier.defaultWeight()) { NoteCardView(row[0], look, lines = lines, items = 4) }
                            Spacer(GlanceModifier.width(6.dp))
                            Box(GlanceModifier.defaultWeight()) { if (row.size > 1) NoteCardView(row[1], look, lines = lines, items = 4) }
                        }
                    }
                    MoreNotes(cards.size - minOf(cards.size, n * 2), shown = n > 0, all)
                }
            }
            else -> {
                fun fits(c: NotesConfig) = Fit.count(cards.map { noteCardHeight(it, c, inner, 2, 3, scale) + 6f }, room, Fit.more(scale))
                val look = if (fits(cfg) == 0) cfg.copy(titlesOnly = true) else cfg
                val n = fits(look)
                Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                    for (c in cards.take(n)) Box(GlanceModifier.padding(vertical = 3.dp)) { NoteCardView(c, look, lines = 2, items = 3) }
                    MoreNotes(cards.size - n, shown = n > 0, all)
                }
            }
        }
        Footer(notice, stale)
    }
}

/** A small glyph on a card: pinned, voice, picture, shared, not sent yet. */
@Composable
private fun Glyph(icon: Int, label: String, tint: GlanceColor) {
    Image(
        ImageProvider(icon), contentDescription = label,
        modifier = GlanceModifier.size(14.dp).padding(end = 2.dp), colorFilter = ColorFilter.tint(tint),
    )
}

/** "3 more notes", or "3 notes" when none fit above it. */
@Composable
private fun MoreNotes(left: Int, shown: Boolean, open: androidx.glance.action.Action) {
    if (left <= 0) return
    MoreLine(
        when {
            !shown -> if (left == 1) "1 note" else "$left notes"
            left == 1 -> "1 more note"
            else -> "$left more notes"
        },
        open,
    )
}

/** How tall one note card is drawn (dp, rounded up) at [width]: see [NoteCardView]. */
internal fun noteCardHeight(c: NoteCard, cfg: NotesConfig, width: Float, lines: Int, items: Int, scale: Float = 1f): Float {
    val text = width - 20f
    var h = 16f + Fit.lines(c.title, 13f, text - if (c.pinned) 14f else 0f, 2, scale) * Fit.line(13f, scale)
    if (!cfg.titlesOnly) {
        if (c.isList) {
            val shown = c.items.filter { !it.checked || it.settling }.take(items)
            h += shown.size * Fit.CHECK
            if (NotesLogic.listLine(c, shown.size) != null) h += Fit.line(11f, scale)
        } else if (c.text.isNotBlank()) {
            h += Fit.lines(c.text, 12f, text, lines, scale) * Fit.line(12f, scale)
        }
    }
    if (c.voice || c.image || c.shared || c.pending) h += 4f + maxOf(14f, Fit.line(10f, scale))
    return h
}

@Composable
fun NoteCardView(c: NoteCard, cfg: NotesConfig, lines: Int, items: Int) {
    val ctx = LocalContext.current
    val fg = NoteTint.text(c.color)
    val muted = NoteTint.muted(c.color)
    val open = actionStartActivity(Open.page(ctx, Open.NOTES, if (c.pending) "/notes" else notePath(c.id)))
    Column(
        GlanceModifier.fillMaxWidth().background(NoteTint.background(c.color)).cornerRadius(12.dp).padding(horizontal = 10.dp, vertical = 8.dp)
            .clickable(open),
    ) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(c.title, style = WText.style(13.sp, fg, bold = true), maxLines = 2, modifier = GlanceModifier.defaultWeight())
            if (c.pinned) Glyph(R.drawable.wg_pin, "Pinned", muted)
        }
        if (!cfg.titlesOnly) {
            if (c.isList) {
                val open1 = c.items.filter { !it.checked || it.settling }.take(items)
                for (it in open1) NoteItemLine(c, it, fg, muted, compact = true)
                NotesLogic.listLine(c, open1.size)?.let { Text(it, style = WText.style(11.sp, muted), maxLines = 1) }
            } else if (c.text.isNotBlank()) {
                Text(c.text, style = WText.style(12.sp, fg), maxLines = lines)
            }
        }
        val glyphs = c.voice || c.image || c.shared || c.pending
        if (glyphs) {
            Row(GlanceModifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                if (c.voice) Glyph(R.drawable.wg_mic, "Has a recording", muted)
                if (c.image) Glyph(R.drawable.wg_camera, "Has pictures", muted)
                if (c.shared) Glyph(R.drawable.wg_people, "Shared with you", muted)
                if (c.pending) {
                    Glyph(R.drawable.ic_sync, "Saved on this phone — will sync", muted)
                    Text("Will sync", style = WText.style(10.sp, muted), maxLines = 1)
                }
            }
        }
    }
}

/** One list item: a tick box (or, for one not sent yet, the sync mark) and its words. */
@Composable
private fun NoteItemLine(note: NoteCard, it: NoteItemRow, fg: GlanceColor, muted: GlanceColor, compact: Boolean) {
    val pad = if (it.indent) 16.dp else 0.dp
    if (it.pending || note.pending) {
        Row(GlanceModifier.fillMaxWidth().padding(start = pad, top = 1.dp, bottom = 1.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(GlanceModifier.width(if (compact) 28.dp else 32.dp), contentAlignment = Alignment.Center) {
                Image(ImageProvider(R.drawable.ic_sync), contentDescription = "Saved on this phone — will sync", modifier = GlanceModifier.size(14.dp), colorFilter = ColorFilter.tint(muted))
            }
            Text(it.text, style = WText.style(12.sp, fg), maxLines = if (compact) 1 else 3)
        }
        return
    }
    // The words tick it too (a home-screen check box only takes taps on the box itself).
    val tick = actionRunCallback<TickNoteItem>(
        actionParametersOf(TickNoteItem.NOTE to note.id, TickNoteItem.ITEM to it.id, TickNoteItem.CHECKED to !it.checked, TickNoteItem.LABEL to it.text.take(60)),
    )
    Row(GlanceModifier.fillMaxWidth().padding(start = pad).clickable(tick), verticalAlignment = Alignment.CenterVertically) {
        CheckBox(
            checked = it.checked,
            onCheckedChange = tick,
            colors = CheckboxDefaults.colors(checkedColor = WColors.accent, uncheckedColor = muted),
            modifier = GlanceModifier.semantics { contentDescription = (if (it.checked) "Untick " else "Tick ") + it.text },
        )
        Text(
            it.text,
            style = WText.style(if (compact) 12.sp else 13.sp, if (it.checked) muted else fg, struck = it.checked),
            maxLines = if (compact) 1 else 3,
            modifier = GlanceModifier.defaultWeight(),
        )
    }
}

/** A tick on a Notes or One note widget: shown at once, sent when there's signal. */
class TickNoteItem : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val note = parameters[NOTE] ?: return
        val item = parameters[ITEM] ?: return
        val checked = parameters[CHECKED] ?: true
        WidgetStore.tickNoteItem(context, note, item, checked, parameters[LABEL].orEmpty(), System.currentTimeMillis())
        Widgets.redraw(context)
        if (checked) {
            // Ticked: it stays where it is for a moment (a second tap undoes it, and
            // nothing is sent), then moves down with the ticked ones.
            Widgets.redrawLater(context, WidgetStore.STRUCK_MS + 150)
            WidgetSync.now(context, delayMs = WidgetStore.STRUCK_MS + 1_000)
        } else {
            WidgetSync.now(context, delayMs = 2_000)
        }
    }

    companion object {
        val NOTE = ActionParameters.Key<String>("note")
        val ITEM = ActionParameters.Key<String>("item")
        val CHECKED = ActionParameters.Key<Boolean>("checked")
        val LABEL = ActionParameters.Key<String>("label")
    }
}

// ------------------------------------------------------------------ One note

class OneNoteWidget : GlanceAppWidget() {
    // Exact: the items that fit this widget's real size (it never scrolls).
    override val sizeMode = SizeMode.Exact
    override val stateDefinition: GlanceStateDefinition<*> = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        WidgetStore.load(context)
        val widgetId = runCatching { GlanceAppWidgetManager(context).getAppWidgetId(id) }.getOrDefault(AppWidgetManager.INVALID_APPWIDGET_ID)
        provideContent {
            val state = WidgetStore.state.collectAsState().value
            val prefs = currentState<Preferences>()
            val ctx = LocalContext.current
            val link = Widgets.link(ctx)
            if (link != Link.LINKED) LinkMessage(ctx, link)
            else OneNoteContent(state, prefs[NOTE_ID]?.ifBlank { null }, prefs[NOTE_TITLE].orEmpty(), System.currentTimeMillis(), clockOf(ctx), widgetId, LocalSize.current)
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        provideContent { OneNoteContent(Samples.notes(), Samples.LIST_ID, "Shopping", Samples.now(), clockOf(context), AppWidgetManager.INVALID_APPWIDGET_ID, NotesWidget.TALL) }
    }

    companion object {
        val NOTE_ID = stringPreferencesKey("note_id")
        val NOTE_TITLE = stringPreferencesKey("note_title")
    }
}

class OneNoteWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = OneNoteWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Widgets.onEnabled(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        Widgets.onDisabled(context)
    }
}

/** The One note widget's settings (pick a note), from a tap on the widget. */
fun pickNote(ctx: Context, widgetId: Int): Intent =
    Intent(ctx, OneNoteConfigActivity::class.java)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
        .setData(Uri.parse("promptly-widget://pick-note/$widgetId"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

fun addItem(ctx: Context, noteId: String, title: String): Intent =
    Intent(ctx, AddItemActivity::class.java)
        .putExtra(AddItemActivity.EXTRA_NOTE, noteId)
        .putExtra(AddItemActivity.EXTRA_TITLE, title)
        .setData(Uri.parse("promptly-widget://add-item/$noteId"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

@Composable
private fun Centered(title: String, hint: String, action: Action?) {
    Frame {
        Column(
            GlanceModifier.fillMaxSize().then(if (action != null) GlanceModifier.clickable(action) else GlanceModifier),
            verticalAlignment = Alignment.CenterVertically, horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Image(ImageProvider(R.drawable.wg_list), contentDescription = null, modifier = GlanceModifier.size(26.dp), colorFilter = ColorFilter.tint(WColors.accent))
            Spacer(GlanceModifier.height(6.dp))
            Text(title, style = WText.style(14.sp, bold = true).copy(textAlign = TextAlign.Center), maxLines = 2)
            Spacer(GlanceModifier.height(2.dp))
            Text(hint, style = WText.style(12.sp, WColors.muted).copy(textAlign = TextAlign.Center), maxLines = 3)
        }
    }
}

@Composable
fun OneNoteContent(state: WidgetState, noteId: String?, savedTitle: String, now: Long, clock: Clock, widgetId: Int, size: DpSize = NotesWidget.TALL) {
    val ctx = LocalContext.current
    val pick = if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) actionStartActivity(pickNote(ctx, widgetId)) else null
    if (noteId == null) return Centered("Pick a note", "Tap to choose the note or list to show here.", pick)
    val note = NotesLogic.one(state, noteId, now)
    if (note == null) {
        return Centered(savedTitle.ifBlank { "Getting your note…" }, if (savedTitle.isBlank()) "It shows once the phone has synced." else "Getting it…", null)
    }
    if (note.gone) return Centered("This note isn't available", "It was deleted, or isn't shared with you any more. Tap to pick another.", pick)

    val fg = NoteTint.text(note.color)
    val muted = NoteTint.muted(note.color)
    val stale = staleLabel(state.snapshot.fetchedAt, now, clock)
    val notice = state.notices.lastOrNull { it.area == "notes" }
    val scale = ctx.resources.configuration.fontScale
    val openNote = actionStartActivity(Open.page(ctx, Open.NOTES, if (note.pending) "/notes" else notePath(note.id)))
    // The room under the title for the list or the words (no scrolling: see Fit).
    val head = maxOf(if (note.isList && !note.pending) 32f else 0f, Fit.line(15f, scale) + if (note.isList) Fit.line(12f, scale) else 0f) + 4f
    val room = size.height.value - Fit.FRAME - Fit.SPARE - head - Fit.footer(notice != null, stale != null, scale)
    Column(
        GlanceModifier.fillMaxSize().background(NoteTint.background(note.color)).cornerRadius(20.dp).padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Row(GlanceModifier.fillMaxWidth().padding(bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(
                GlanceModifier.defaultWeight().clickable(actionStartActivity(Open.page(ctx, Open.NOTES, if (note.pending) "/notes" else notePath(note.id))))
                    .semantics { contentDescription = "Open ${note.title} in P Notes" },
            ) {
                Text(note.title, style = WText.style(15.sp, fg, bold = true), maxLines = 1)
                if (note.isList) {
                    Text(
                        when {
                            note.total == 0 && note.items.isEmpty() -> "Empty list"
                            note.left == 0 -> "All ticked"
                            else -> "${note.left} left"
                        },
                        style = WText.style(12.sp, muted), maxLines = 1,
                    )
                }
            }
            if (note.isList && !note.pending) AddButton("Add to ${note.title}", actionStartActivity(addItem(ctx, note.id, note.title)))
        }
        if (note.isList) {
            val open = note.items.filter { !it.checked || it.settling }
            val done = note.items.filter { it.checked && !it.settling }
            if (note.items.isEmpty()) {
                Column(GlanceModifier.defaultWeight().fillMaxWidth()) { Text("Nothing on the list. Tap + to add.", style = WText.style(12.sp, muted), maxLines = 2) }
            } else {
                val rows: List<Pair<String, NoteItemRow?>> = open.map { "i" + it.id to it } +
                    (if (done.isNotEmpty()) listOf("h" to null) else emptyList()) + done.map { "i" + it.id to it }
                val itemW = size.width.value - 24f - 32f
                val heights = rows.map { (_, row) ->
                    if (row == null) Fit.line(11f, scale) + 8f
                    else maxOf(Fit.CHECK, Fit.lines(row.text, 13f, itemW - if (row.indent) 16f else 0f, 3, scale) * Fit.line(13f, scale))
                }
                var n = Fit.count(heights, room, Fit.more(scale))
                // "2 ticked" with nothing under it goes too.
                while (n > 0 && rows[n - 1].second == null) n--
                val left = rows.drop(n).count { it.second != null }
                Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                    for ((_, row) in rows.take(n)) {
                        if (row == null) {
                            Text(
                                if (done.size == 1) "1 ticked" else "${done.size} ticked",
                                style = WText.style(11.sp, muted), maxLines = 1, modifier = GlanceModifier.padding(top = 6.dp, bottom = 2.dp),
                            )
                        } else NoteItemLine(note, row, fg, muted, compact = false)
                    }
                    if (left > 0) MoreLine("$left more", openNote)
                }
            }
        } else {
            // As many whole lines as fit, then "…"; tap to read the rest.
            Column(GlanceModifier.defaultWeight().fillMaxWidth().clickable(openNote)) {
                Text(
                    note.text.ifBlank { if (note.voice) "A voice note — open it to listen." else "Nothing written yet." },
                    style = WText.style(13.sp, if (note.text.isBlank()) muted else fg),
                    maxLines = maxOf(1, (room / Fit.line(13f, scale)).toInt()),
                )
            }
        }
        if (notice != null || stale != null) Footer(notice, stale)
    }
}
