package org.promptly.sync

import android.content.Context
import android.provider.MediaStore
import androidx.activity.result.IntentSenderRequest
import androidx.annotation.RequiresApi

/**
 * "Free up space": photos and videos on this phone that are safely in
 * Promptly, removed from the phone — Android asks first, with its own
 * "Delete these?" dialog.
 *
 * A file is only ever removed when all of this holds:
 * - this app backed it up (the ledger has it as sent), from a chosen folder;
 * - the server holds those exact bytes in Photos right now — the file on
 *   the phone is hashed (SHA-256) at the time of the check, not trusted from
 *   an old record, and the server answers "have" only for a file in Photos
 *   that isn't in the trash or deleted;
 * - and, at the moment you tap Free up, it's still unchanged on the phone
 *   and the server still has it (asked again).
 * Anything else — not backed up yet, refused, deleted in Promptly, edited
 * since, unreadable — stays on the phone.
 */
object FreeUp {
    /** What can go: each file with the SHA-256 of its bytes now. */
    data class Plan(val items: List<Pair<Item, String>>, val bytes: Long)

    private const val DAY = 24L * 60 * 60 * 1000

    /** One Android dialog covers this many (a longer list is too big to hand over). */
    private const val BATCH = 1000

    /** What can go: off the main thread (it reads every candidate, and asks the server). */
    fun plan(context: Context, account: Store.Account, buckets: Set<String>, keepDays: Int, progress: (Int, Int) -> Unit): Plan {
        val ledger = Ledger(context)
        val done = ledger.doneHashes()
        val cutoff = System.currentTimeMillis() - keepDays * DAY
        val candidates = Media.items(context, buckets).filter { item ->
            val sent = done[item.id] ?: return@filter false
            sent.first == item.sig && (item.taken ?: (item.modified * 1000)) < cutoff
        }
        val hashed = ArrayList<Pair<Item, String>>()
        candidates.forEachIndexed { i, item ->
            progress(i, candidates.size)
            runCatching { Media.sha256(context, item) }.getOrNull()?.let { hashed += item to it }
        }
        val safe = stored(account, hashed)
        return Plan(safe, safe.sumOf { it.first.size })
    }

    /** Just before deleting: the plan again, keeping only files that are still
     *  exactly as checked on the phone and still in Promptly. */
    fun recheck(context: Context, account: Store.Account, plan: Plan, buckets: Set<String>): List<Item> {
        val now = Media.items(context, buckets).associateBy { it.id }
        val unchanged = plan.items.filter { (item, _) -> now[item.id]?.sig == item.sig }
        return stored(account, unchanged).map { it.first }
    }

    /** Those whose bytes the server says are in Photos (``have`` — never ``skip``). */
    private fun stored(account: Store.Account, hashed: List<Pair<Item, String>>): List<Pair<Item, String>> {
        val out = ArrayList<Pair<Item, String>>()
        for (batch in hashed.chunked(500)) {
            val known = Api.have(account, batch.map { it.second }.distinct())
            batch.filter { it.second in known.have }.forEach { out += it }
        }
        return out
    }

    /** Android's "Allow PromptlySync to delete N items?" — one per [BATCH]. */
    @RequiresApi(30)
    fun requests(context: Context, items: List<Item>): List<IntentSenderRequest> =
        items.chunked(BATCH).map { batch ->
            val pending = MediaStore.createDeleteRequest(context.contentResolver, batch.map { it.uri })
            IntentSenderRequest.Builder(pending.intentSender).build()
        }
}
