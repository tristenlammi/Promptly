package org.promptly.sync.maps.offline

import java.io.File
import java.io.IOException

/**
 * Brings the phone's offline maps in line with what your areas want: asks the server
 * for signed links (`GET /api/maps/offline/files`), downloads what's new or changed
 * ([Downloader]: resumable, SHA-256 checked), puts each file in place as it arrives,
 * swaps in a new routing build whole, and removes what no area wants any more.
 *
 * Plain code with no Android services, so it runs against a fake server in tests.
 * [freeSpace] is the phone's free bytes where [store] lives; [stopped] is checked
 * between chunks (Wi-Fi gone, cancelled); [onProgress] hears each step.
 */
class OfflineEngine(
    private val store: OfflineStore,
    private val api: OfflineApi,
    private val downloader: Downloader = Downloader(),
    private val freeSpace: () -> Long,
    private val stopped: () -> Boolean = { false },
    private val onProgress: (Progress) -> Unit = {},
) {
    /** One thing to fetch or copy this run. */
    data class Item(val file: OfflineApi.PackFile, val copy: Boolean)

    /** The run so far: what it's fetching, what's done, and the file it's on. */
    data class Progress(
        val build: String,
        val items: List<Item>,
        val done: Set<String>,
        val current: String?,
        val currentBytes: Long,
        val updating: Boolean,
    ) {
        val total: Long get() = items.sumOf { it.file.bytes }
        val have: Long get() = items.filter { it.file.key in done }.sumOf { it.file.bytes } + currentBytes

        /** For one area: what of its squares (and the shared files they need) is here. */
        fun forCells(cells: Collection<String>): Pair<Long, Long> {
            val set = cells.toSet()
            val l0 = set.mapNotNull { runCatching { Cells.level0(it) }.getOrNull() }.toSet()
            val mine = items.filter { i ->
                val f = i.file
                f.cell in set || (f.kind == "l0" && f.tile in l0) || f.cell == null && f.kind != "l0"
            }
            val total = mine.sumOf { it.file.bytes }
            val have = mine.filter { it.file.key in done }.sumOf { it.file.bytes } +
                (if (mine.any { it.file.key == current }) currentBytes else 0)
            return have to total
        }
    }

    /** Downloads and installs everything [wanted] (square → with house numbers) needs.
     *  Returns the build it ended on. */
    fun sync(wanted: Map<String, Boolean>): OfflineApi.Listing? {
        store.recover()
        // What no area wants goes first: it frees space for what's coming.
        store.prune(wanted)
        if (wanted.isEmpty()) {
            finished(null, emptyMap())
            return null
        }
        var relists = 0
        while (true) {
            val listing = api.files(wanted.keys.sorted(), wanted.values.any { it })
            try {
                run(listing, wanted)
                return listing
            } catch (e: LinkGone) {
                // A link ran out, or a new build went live mid-download: ask again. What's
                // downloaded is kept (files are named by their SHA-256, so an unchanged file
                // in the new build carries on where it stopped).
                if (++relists > 3) throw IOException("The server keeps changing its downloads. It'll try again later.")
            }
        }
    }

    private fun run(listing: OfflineApi.Listing, wanted: Map<String, Boolean>) {
        val s = store.state
        val build = listing.build
        listing.builtAt?.let { s.builds[build] = it }

        // Routing is all one build. A new build goes into routing-next/, whole.
        if (s.dropOld && s.routingBuild != null && s.routingBuild != build) {
            store.dropRouting()
        }
        s.dropOld = false
        val updating = s.routingBuild != null && s.routingBuild != build
        if (updating && s.nextBuild != build) {
            store.dropNext()
            s.nextBuild = build
        } else if (!updating && (s.nextBuild != null || store.nextDir.exists())) {
            store.dropNext()
        }
        store.save()

        val files = listing.files.filter { f -> f.kind != "addresses" || wanted[f.cell] == true }
        val items = files.mapNotNull { f ->
            when {
                f.routing && updating -> when {
                    s.next[f.key]?.sha == f.sha256 -> null
                    s.routing[f.key]?.sha == f.sha256 -> Item(f, copy = true)
                    else -> Item(f, copy = false)
                }
                f.routing -> if (s.routing[f.key]?.sha == f.sha256) null else Item(f, copy = false)
                else -> if (s.files[f.key]?.sha == f.sha256) null else Item(f, copy = false)
            }
        }.sortedWith(compareBy({ order(it.file) }, { it.file.cell ?: "" }, { kindOrder(it.file.kind) }))

        checkSpace(items, updating)

        val done = mutableSetOf<String>()
        fun tell(current: String?, bytes: Long) = onProgress(Progress(build, items, done.toSet(), current, bytes, updating))
        tell(null, 0)
        for (item in items) {
            if (stopped()) throw Stopped()
            val f = item.file
            if (item.copy) {
                store.copyToNext(f.key)
            } else {
                val got = fetch(f) { tell(f.key, it) }
                install(f, got, build, updating)
            }
            store.save()
            done += f.key
            tell(null, 0)
        }

        if (updating) {
            val missing = files.filter { it.routing && it.key !in s.next }
            if (missing.isNotEmpty()) throw IOException("The new routing isn't complete yet. It'll carry on by itself.")
            store.swap()
        }
        finished(build, wanted)
    }

    private fun finished(build: String?, wanted: Map<String, Boolean>) {
        val s = store.state
        s.synced.clear()
        // What the server has none of (the sea) counts as done: there's nothing to get.
        for ((cell, addresses) in wanted) s.synced[cell] = addresses
        s.syncedBuild = build
        s.problem = null
        s.noSpace = null
        s.noSpaceFree = null
        s.noSpaceCanDrop = false
        store.downloadsDir.deleteRecursively()
        store.save()
    }

    /** Base files first (small, and cameras matter), then level-0 tiles, then square by square. */
    private fun order(f: OfflineApi.PackFile) = when (f.kind) {
        "cameras", "chargers" -> 0
        "l0" -> 1
        else -> 2
    }

    private fun kindOrder(kind: String) = listOf("map", "places", "addresses", "route", "l0", "cameras", "chargers").indexOf(kind)

    private fun checkSpace(items: List<Item>, updating: Boolean) {
        val s = store.state
        fun partOf(f: OfflineApi.PackFile): Long {
            val part = File(store.downloadsDir, "${f.sha256}.part")
            val done = File(store.downloadsDir, f.sha256)
            return if (done.isFile) f.bytes else if (part.isFile) minOf(part.length(), f.bytes) else 0
        }
        fun need(asDownloads: Boolean): Long {
            var total = 0L
            var biggestTar = 0L
            for (i in items) {
                val f = i.file
                if (i.copy && !asDownloads) {
                    total += s.routing[f.key]?.disk ?: f.bytes
                    continue
                }
                total += f.bytes - partOf(f)
                // A tar is unpacked next to itself before it's deleted; search gets an index.
                if (f.routing) biggestTar = maxOf(biggestTar, f.bytes)
                if (f.kind == "places") total += f.bytes * 2 / 5
            }
            return total + biggestTar + MARGIN
        }
        val free = freeSpace()
        val need = need(asDownloads = false)
        if (need <= free) return
        val routingDisk = s.routing.values.sumOf { it.disk }
        val canDrop = updating && need(asDownloads = true) <= free + routingDisk
        s.problem = "no_space"
        s.noSpace = need
        s.noSpaceFree = free
        s.noSpaceCanDrop = canDrop
        store.save()
        throw NoSpace(need, free, canDrop)
    }

    /** Downloads one file, trying once more from scratch if it arrives damaged. */
    private fun fetch(f: OfflineApi.PackFile, onBytes: (Long) -> Unit): File {
        val part = File(store.downloadsDir, "${f.sha256}.part")
        val done = File(store.downloadsDir, f.sha256)
        val url = if (f.url.startsWith("http")) f.url else api.server.trimEnd('/') + f.url
        try {
            downloader.fetch(url, f.bytes, f.sha256, part, done, stopped, onBytes)
        } catch (e: Damaged) {
            downloader.fetch(url, f.bytes, f.sha256, part, done, stopped, onBytes)
        }
        return done
    }

    private fun install(f: OfflineApi.PackFile, got: File, build: String, updating: Boolean) {
        val s = store.state
        val cell = f.cell
        when (f.kind) {
            "map" -> {
                val dest = store.mapFile(cell!!)
                moveInto(got, dest)
                s.files[f.key] = OfflineStore.Installed(f.sha256, f.bytes, build, f.bytes)
            }
            "cameras", "chargers" -> {
                moveInto(got, File(store.baseDir, "${f.kind}.json"))
                s.files[f.key] = OfflineStore.Installed(f.sha256, f.bytes, build, f.bytes)
            }
            "places" -> {
                store.search.putPlaces(cell!!, got, f.sha256)
                got.delete()
                s.files[f.key] = OfflineStore.Installed(f.sha256, f.bytes, build, f.bytes * 4 / 3)
            }
            "addresses" -> {
                store.search.putAddresses(cell!!, got, f.sha256)
                got.delete()
                s.files[f.key] = OfflineStore.Installed(f.sha256, f.bytes, build, f.bytes)
            }
            "route", "l0" -> {
                val (dir, entries) = if (updating) store.nextDir to s.next else store.routingDir to s.routing
                entries[f.key]?.let { store.removeMembers(dir, it) }
                dir.mkdirs()
                val members = Tar.extract(got, dir, stopped)
                got.delete()
                entries[f.key] = OfflineStore.Installed(f.sha256, f.bytes, build, members.sumOf { it.bytes }, members.map { it.path })
                if (!updating) s.routingBuild = build
            }
            else -> got.delete()
        }
    }

    private fun moveInto(from: File, dest: File) {
        dest.parentFile?.mkdirs()
        if (!from.renameTo(dest)) {
            dest.delete()
            if (!from.renameTo(dest)) throw IOException("Couldn't put a download in place.")
        }
    }

    companion object {
        /** Room left over for the phone itself. */
        const val MARGIN = 64L * 1024 * 1024
    }
}
