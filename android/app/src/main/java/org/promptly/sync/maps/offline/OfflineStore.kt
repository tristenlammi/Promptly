package org.promptly.sync.maps.offline

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * What's on this phone for offline P Maps, under `filesDir/maps-offline/`:
 *
 * - `cells/<cell>/map.pmtiles`: each square's map (PMTiles v3, the server's cut of
 *   its basemap). Squares from different builds can sit side by side.
 * - `routing/`: ONE Valhalla tile folder (`0/…`, `1/…`, `2/…` `.gph`), every square's
 *   routing tiles plus the level-0 tiles they need, **all from one build**
 *   ([State.routingBuild]): tiles point into their neighbours by id, so two builds
 *   could route wrongly at the seams. A new build is downloaded whole into
 *   `routing-next/` and swapped in with two renames ([swap]); until then the old
 *   set keeps working.
 * - `search.db`: every square's places, streets and house numbers in one SQLite
 *   database with one FTS4 index ([SearchDb]).
 * - `base/cameras.json`, `base/chargers.json`: all of Australia's.
 * - `map-assets/…`: the server's public styles, fonts and sprites ([MapAssets]).
 * - `downloads/`: files on their way in (`<sha256>.part`, resumed with Range).
 * - `state.json`: what's installed, from which build, and each routing file's tiles.
 */
class OfflineStore(val root: File) {
    val routingDir = File(root, "routing")
    val nextDir = File(root, "routing-next")
    private val oldDir = File(root, "routing-old")
    val cellsDir = File(root, "cells")
    val baseDir = File(root, "base")
    val assetsDir = File(root, "map-assets")
    val downloadsDir = File(root, "downloads")
    val search = SearchDb(File(root, "search.db"))
    private val stateFile = File(root, "state.json")

    /** One file that's in place. [members]: the tiles a routing tar put in the tile folder. */
    data class Installed(val sha: String, val bytes: Long, val build: String, val disk: Long, val members: List<String> = emptyList())

    class State {
        var routingBuild: String? = null
        val routing = mutableMapOf<String, Installed>()
        var nextBuild: String? = null
        val next = mutableMapOf<String, Installed>()
        var swapping = false
        /** Maps (`<cell>/map`), search (`<cell>/places`, `<cell>/addresses`) and `base/<kind>`. */
        val files = mutableMapOf<String, Installed>()
        /** Each build's date, for "map from 3 Nov". */
        val builds = mutableMapOf<String, String>()
        /** The squares the last finished download covered (true: with house numbers), and its build. */
        val synced = mutableMapOf<String, Boolean>()
        var syncedBuild: String? = null
        /** You said yes to "Update by removing the old copy first". */
        var dropOld = false
        /** Areas deleted on this phone while the server couldn't be told. */
        val deleted = mutableSetOf<String>()
        /** Why the last download stopped, in words for the screen; null when it finished. */
        var problem: String? = null
        var noSpace: Long? = null
        var noSpaceFree: Long? = null
        var noSpaceCanDrop = false

        fun toJson(): JSONObject = JSONObject()
            .put("routing_build", routingBuild)
            .put("routing", map(routing))
            .put("next_build", nextBuild)
            .put("next", map(next))
            .put("swapping", swapping)
            .put("files", map(files))
            .put("builds", JSONObject(builds as Map<*, *>))
            .put("synced", JSONObject(synced as Map<*, *>))
            .put("synced_build", syncedBuild)
            .put("drop_old", dropOld)
            .put("deleted", JSONArray(deleted.toList()))
            .put("problem", problem)
            .put("no_space", noSpace)
            .put("no_space_free", noSpaceFree)
            .put("no_space_can_drop", noSpaceCanDrop)

        companion object {
            private fun map(m: Map<String, Installed>): JSONObject = JSONObject().apply {
                m.forEach { (k, v) ->
                    put(k, JSONObject().put("sha", v.sha).put("bytes", v.bytes).put("build", v.build).put("disk", v.disk)
                        .put("members", JSONArray(v.members)))
                }
            }

            private fun read(j: JSONObject?, into: MutableMap<String, Installed>) {
                j ?: return
                j.keys().forEach { k ->
                    val v = j.getJSONObject(k)
                    val m = v.optJSONArray("members") ?: JSONArray()
                    into[k] = Installed(v.getString("sha"), v.getLong("bytes"), v.getString("build"), v.optLong("disk"), List(m.length()) { m.getString(it) })
                }
            }

            fun from(j: JSONObject): State = State().apply {
                routingBuild = j.text("routing_build")
                read(j.optJSONObject("routing"), routing)
                nextBuild = j.text("next_build")
                read(j.optJSONObject("next"), next)
                swapping = j.optBoolean("swapping")
                read(j.optJSONObject("files"), files)
                j.optJSONObject("builds")?.let { b -> b.keys().forEach { builds[it] = b.getString(it) } }
                j.optJSONObject("synced")?.let { b -> b.keys().forEach { synced[it] = b.getBoolean(it) } }
                syncedBuild = j.text("synced_build")
                dropOld = j.optBoolean("drop_old")
                deleted += j.strings("deleted")
                problem = j.text("problem")
                noSpace = j.long("no_space")
                noSpaceFree = j.long("no_space_free")
                noSpaceCanDrop = j.optBoolean("no_space_can_drop")
            }
        }
    }

    val state: State by lazy {
        runCatching { State.from(JSONObject(stateFile.readText())) }.getOrElse { State() }
    }

    /** Written to a new file and renamed over the old, so a crash never leaves half a state. */
    fun save() {
        root.mkdirs()
        val tmp = File(root, "state.json.new")
        tmp.writeText(state.toJson().toString())
        if (!tmp.renameTo(stateFile)) {
            stateFile.delete()
            if (!tmp.renameTo(stateFile)) throw IOException("Couldn't save the offline maps' state.")
        }
    }

    fun mapFile(cell: String) = File(cellsDir, "$cell/map.pmtiles")

    private companion object {
        /** Small notes about the files, not map data. */
        val BOOKKEEPING = setOf("state.json", "overview.json", "state.json.new", "overview.json.new")
    }

    // ---- The routing folder: one build, swapped whole ------------------------------

    /** Finishes a swap a crash interrupted, and clears what an old one left. */
    fun recover() {
        val s = state
        if (s.swapping) {
            if (nextDir.exists() && routingDir.exists()) {
                if (!routingDir.renameTo(oldDir)) throw IOException("Couldn't swap in the new routing.")
            }
            if (nextDir.exists() && !routingDir.exists()) {
                if (!nextDir.renameTo(routingDir)) throw IOException("Couldn't swap in the new routing.")
            }
            finishSwap()
        }
        if (oldDir.exists()) oldDir.deleteRecursively()
    }

    /** Puts `routing-next/` (all one build) in place of `routing/`. */
    fun swap() {
        val s = state
        s.swapping = true
        save()
        if (routingDir.exists() && !routingDir.renameTo(oldDir)) throw IOException("Couldn't swap in the new routing.")
        nextDir.mkdirs()
        if (!nextDir.renameTo(routingDir)) throw IOException("Couldn't swap in the new routing.")
        finishSwap()
        oldDir.deleteRecursively()
    }

    private fun finishSwap() {
        val s = state
        s.routing.clear()
        s.routing.putAll(s.next)
        s.routingBuild = s.nextBuild
        s.next.clear()
        s.nextBuild = null
        s.swapping = false
        save()
    }

    /** Forgets an update in progress (it was for a build that's gone). */
    fun dropNext() {
        nextDir.deleteRecursively()
        state.next.clear()
        state.nextBuild = null
    }

    /** Removes the current routing set: offline directions are off until a new one is in. */
    fun dropRouting() {
        routingDir.deleteRecursively()
        state.routing.clear()
        state.routingBuild = null
    }

    fun removeMembers(dir: File, entry: Installed) {
        entry.members.forEach { File(dir, it).delete() }
    }

    /** Copies one routing file's tiles from the current set into `routing-next/` (same bytes, new build). */
    fun copyToNext(key: String) {
        val entry = state.routing[key] ?: return
        entry.members.forEach { m ->
            val src = File(routingDir, m)
            val dest = File(nextDir, m)
            dest.parentFile?.mkdirs()
            src.copyTo(dest, overwrite = true)
        }
        state.next[key] = entry.copy(build = state.nextBuild ?: entry.build)
    }

    /** Whether offline routing has every square of [cells], all from one build. */
    fun routingReady(cells: Collection<String>): Boolean {
        val s = state
        return s.routingBuild != null && !s.swapping && cells.all { "$it/route" in s.routing }
    }

    // ---- Keeping only what's wanted -----------------------------------------------

    /** Removes squares no area wants any more, house numbers no area wants, and level-0
     *  tiles no remaining square needs. [wanted]: square → with house numbers. */
    fun prune(wanted: Map<String, Boolean>) {
        val s = state
        val level0 = wanted.keys.mapNotNull { runCatching { Cells.level0(it) }.getOrNull() }.toSet()
        for (key in s.files.keys.toList()) {
            val (owner, kind) = key.split("/", limit = 2)
            if (owner == "base") {
                if (wanted.isEmpty()) {
                    File(baseDir, "$kind.json").delete()
                    s.files.remove(key)
                }
                continue
            }
            val keep = when (kind) {
                "addresses" -> wanted[owner] == true
                else -> owner in wanted
            }
            if (keep) continue
            when (kind) {
                "map" -> {
                    mapFile(owner).delete()
                    mapFile(owner).parentFile?.delete()
                }
                "places" -> search.remove(owner)
                "addresses" -> search.remove(owner, onlyAddresses = true)
            }
            s.files.remove(key)
        }
        for ((dir, entries) in listOf(routingDir to s.routing, nextDir to s.next)) {
            for ((key, entry) in entries.toList()) {
                val (owner, rest) = key.split("/", limit = 2)
                val keep = if (owner == "l0") rest.toIntOrNull() in level0 else owner in wanted
                if (!keep) {
                    removeMembers(dir, entry)
                    entries.remove(key)
                }
            }
        }
        s.synced.keys.retainAll(wanted.keys)
        for ((cell, addresses) in wanted) if (!addresses && s.synced[cell] == true) s.synced[cell] = false
        if (wanted.isEmpty()) {
            dropRouting()
            dropNext()
            s.syncedBuild = null
            search.file.delete()
            File(search.file.path + "-journal").delete()
            cellsDir.deleteRecursively()
            downloadsDir.deleteRecursively()
        }
        removeEmptyFolders(routingDir)
        removeEmptyFolders(nextDir)
        save()
    }

    private fun removeEmptyFolders(dir: File) {
        if (!dir.isDirectory) return
        dir.walkBottomUp().forEach { if (it != dir && it.isDirectory && it.list()?.isEmpty() == true) it.delete() }
    }

    // ---- Sizes ------------------------------------------------------------------

    /** Everything offline maps keep on this phone. */
    fun diskBytes(): Long = if (!root.exists()) 0 else root.walkTopDown()
        .filter { it.isFile && (it.parentFile != root || it.name !in BOOKKEEPING) }
        .sumOf { it.length() }

    /** About what deleting an area frees: its squares that no other area keeps, and
     *  level-0 tiles only those squares need. */
    fun freedBy(cells: Collection<String>, others: Collection<String>): Long {
        val s = state
        val only = cells.toSet() - others.toSet()
        if (only.isEmpty()) return 0
        val otherL0 = others.mapNotNull { runCatching { Cells.level0(it) }.getOrNull() }.toSet()
        val l0 = only.mapNotNull { runCatching { Cells.level0(it) }.getOrNull() }.filter { it !in otherL0 }.toSet()
        var total = 0L
        for ((key, v) in s.files) if (key.substringBefore('/') in only) total += v.disk
        for (entries in listOf(s.routing, s.next)) {
            for ((key, v) in entries) {
                val owner = key.substringBefore('/')
                if (owner in only || (owner == "l0" && key.substringAfter('/').toIntOrNull() in l0)) total += v.disk
            }
        }
        return total
    }

    /** The space a square's files take (map, search, routing), for an area's size. */
    fun cellBytes(cells: Collection<String>): Long {
        val s = state
        val set = cells.toSet()
        val l0 = set.mapNotNull { runCatching { Cells.level0(it) }.getOrNull() }.toSet()
        var total = 0L
        for ((key, v) in s.files) if (key.substringBefore('/') in set) total += v.disk
        for ((key, v) in s.routing) {
            val owner = key.substringBefore('/')
            if (owner in set || (owner == "l0" && key.substringAfter('/').toIntOrNull() in l0)) total += v.disk
        }
        return total
    }

    /** Every square of an area finished downloading (with house numbers if it wants them). */
    fun has(cells: Collection<String>, withAddresses: Boolean): Boolean {
        val s = state
        return cells.all { c -> c in s.synced && (!withAddresses || s.synced[c] == true) }
    }
}
