package org.promptly.sync.widgets

import org.json.JSONArray
import org.json.JSONObject

/*
 * What the Notes widgets show, from the saved copy and the changes made on
 * this phone that haven't gone yet (a tick, an item, a quick note, a voice
 * note): pure functions, tested on their own. Changes show at once; the
 * server's answer then replaces them ([NotesLogic.applyAnswer]).
 */

/** A Notes widget's settings. [titlesOnly]: no text or items on the home screen. */
data class NotesConfig(val titlesOnly: Boolean = false)

object NotesLogic {
    /** The most cards a Notes widget lists. */
    const val MAX_CARDS = 24

    private fun JSONArray?.strings(): List<String> =
        if (this == null) emptyList() else (0 until length()).mapNotNull { optString(it).takeIf { s -> s.isNotBlank() } }

    private fun files(op: Op): List<JSONObject> {
        val arr = op.body.optJSONArray("files") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
    }

    /** A note made on this phone and not sent yet, as a card. */
    fun pendingCard(op: Op): NoteCard {
        val b = op.body
        val kind = b.optString("kind", "text")
        val files = files(op)
        val voice = files.any { it.optString("mime").startsWith("audio/") }
        val items = b.optJSONArray("items").strings().ifEmpty {
            if (kind == "list") b.optString("text").lines().map { it.trim() }.filter { it.isNotEmpty() } else emptyList()
        }
        val text = if (kind == "list") "" else b.optString("text")
        val title = b.optString("title").trim().ifBlank {
            text.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.take(80) ?: if (voice) "Voice note" else if (items.isEmpty()) "Untitled note" else ""
        }
        return NoteCard(
            id = op.id, kind = kind, title = title.ifBlank { "Untitled note" }, voice = voice,
            image = files.any { it.optString("mime").startsWith("image/") },
            text = if (b.optString("title").isBlank() && text.isNotBlank()) text.lines().drop(1).joinToString("\n").trim() else text,
            items = items.mapIndexed { i, t -> NoteItemRow("${op.id}:$i", t, checked = false, indent = false, pending = true) },
            left = items.size, total = items.size, pending = true,
        )
    }

    /** [card] with this phone's waiting changes to it: ticks, new items, things shared into it. */
    fun overlay(card: NoteCard, ops: List<Op>, now: Long = System.currentTimeMillis()): NoteCard {
        var c = card
        for (op in ops) {
            if (op.body.optString("note_id") != card.id) continue
            when (op.type) {
                Op.NOTE_TICK -> {
                    val id = op.body.optString("item_id")
                    val on = op.body.optBoolean("checked")
                    val settling = on && now - op.created < WidgetStore.STRUCK_MS
                    c = c.copy(items = c.items.map { if (it.id == id) it.copy(checked = on, settling = settling) else it })
                }
                Op.NOTE_ITEM -> if (c.isList) {
                    c = c.copy(items = c.items + NoteItemRow(op.id, op.body.optString("text"), checked = false, indent = false, pending = true))
                }
                Op.NOTE_ADD -> {
                    val text = op.body.optString("text").trim()
                    if (text.isNotEmpty()) {
                        c = if (c.isList) c.copy(items = c.items + text.lines().map { it.trim() }.filter { it.isNotEmpty() }
                            .mapIndexed { i, t -> NoteItemRow("${op.id}:$i", t, checked = false, indent = false, pending = true) })
                        else c.copy(text = listOf(c.text, text).filter { it.isNotBlank() }.joinToString("\n"))
                    }
                    val fs = files(op)
                    if (fs.any { it.optString("mime").startsWith("audio/") }) c = c.copy(voice = true)
                    if (fs.any { it.optString("mime").startsWith("image/") }) c = c.copy(image = true)
                }
            }
        }
        if (c === card) return card
        // Unticked first, each in its order; a list's counts follow.
        val items = c.items.filter { !it.checked || it.settling } + c.items.filter { it.checked && !it.settling }
        return if (c.isList) c.copy(items = items, left = c.left + items.count { !it.checked } - card.items.count { !it.checked }, total = c.total + (items.size - card.items.size))
        else c
    }

    /** The cards a Notes widget shows: pinned, then notes made here and not sent, then the rest. */
    fun cards(state: WidgetState, now: Long = System.currentTimeMillis()): List<NoteCard> {
        val sec = state.snapshot.notesSection
        val pending = state.ops.filter { it.type == Op.NEW_NOTE }.map(::pendingCard).reversed()
        val server = sec?.cards.orEmpty().filter { c -> pending.none { it.id == c.id } }.map { overlay(it, state.ops, now) }
        return (server.filter { it.pinned } + pending + server.filter { !it.pinned }).take(MAX_CARDS)
    }

    /** One note for a One note widget: the whole of it if the snapshot has it,
     *  else its card, else one made here and not sent yet. Null: not known yet. */
    fun one(state: WidgetState, id: String, now: Long = System.currentTimeMillis()): NoteCard? {
        val sec = state.snapshot.notesSection
        val full = sec?.notes?.firstOrNull { it.id == id }
        if (full?.gone == true) return full
        val base = full ?: sec?.cards?.firstOrNull { it.id == id }
        if (base != null) return overlay(base, state.ops, now)
        return state.ops.firstOrNull { it.type == Op.NEW_NOTE && it.id == id }?.let(::pendingCard)
    }

    /** Is the item ticked in the saved copy (what the server last said). */
    fun serverChecked(snap: Snapshot, noteId: String, itemId: String): Boolean? {
        val sec = snap.notesSection ?: return null
        return (sec.notes + sec.cards).asSequence().filter { it.id == noteId }.flatMap { it.items.asSequence() }.firstOrNull { it.id == itemId }?.checked
    }

    /**
     * Put the server's answer to a change ({card, full, archived}) into the
     * saved notes section: the card replaced (or added after the pinned ones),
     * the whole note replaced where a One note widget has it. The etag is
     * cleared so the next refresh sends the section whole. Returns whether
     * anything changed.
     */
    fun applyAnswer(section: JSONObject, answer: JSONObject): Boolean {
        val card = answer.optJSONObject("card") ?: return false
        val full = answer.optJSONObject("full")
        val id = card.optString("id")
        val archived = answer.optBoolean("archived")
        val cards = section.optJSONArray("cards") ?: JSONArray()
        val list = (0 until cards.length()).mapNotNull { cards.optJSONObject(it) }
        val out = JSONArray()
        if (list.any { it.optString("id") == id }) {
            // Known: in its place (or out, if archived).
            for (c in list) if (c.optString("id") != id) out.put(c) else if (!archived) out.put(card)
        } else {
            // New: first after the pinned ones (or first of them, if it's pinned).
            var placed = archived
            for (c in list) {
                if (!placed && (card.optBoolean("pinned") || !c.optBoolean("pinned"))) {
                    out.put(card)
                    placed = true
                }
                out.put(c)
            }
            if (!placed) out.put(card)
        }
        section.put("cards", out)
        if (full != null) {
            val notes = section.optJSONArray("notes")
            if (notes != null) for (i in 0 until notes.length()) {
                if (notes.optJSONObject(i)?.optString("id") == id) notes.put(i, full)
            }
        }
        section.put("etag", "")
        return true
    }

    /** "4 left", "All ticked", "3 items" — a list card's quiet line. */
    fun listLine(c: NoteCard, shown: Int): String? {
        val unticked = c.items.count { !it.checked }
        val more = maxOf(0, c.left - minOf(shown, unticked))
        return when {
            c.total == 0 && c.items.isEmpty() -> "Empty list"
            c.left == 0 && unticked == 0 -> "All ticked"
            more > 0 -> "+ $more more"
            else -> null
        }
    }
}
