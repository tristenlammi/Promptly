package org.promptly.sync.maps.offline

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder

/** Something went wrong that the screen says in its own words. */
open class OfflineProblem(message: String) : IOException(message)

/** The phone's sign-in no longer works. */
class SignedOut : OfflineProblem("Sign in to P Maps again: open P Maps on the web and start a trip, or pair this phone.")

/** An admin turned offline packs off (`MAPS_OFFLINE=0`). */
class OffOnServer : OfflineProblem("Offline maps aren't turned on on your server.")

/** The server's map build has no packs yet. */
class StillBuilding : OfflineProblem("Your server is still building its maps. Try again later.")

/** The server said no to something specific; [message] is its own words. */
class ServerSaid(val status: Int, message: String) : OfflineProblem(message)

/** Not enough room on the phone. [canDropOld]: removing the old routing copy first would make room. */
class NoSpace(val need: Long, val free: Long, val canDropOld: Boolean = false) :
    OfflineProblem("Not enough space: this needs ${Sizes.text(need)} and your phone has ${Sizes.text(free)} free.")

/** The run was asked to stop (no Wi-Fi any more, or cancelled). What's downloaded so far is kept. */
class Stopped : IOException("Stopped")

/** A signed link ran out or names an old build: ask for the list again. */
class LinkGone : IOException("That download link has run out.")

/** A file arrived, but not the file the list promised. */
class Damaged(val what: String) : IOException("A download was damaged ($what).")

/** P Maps' offline API (`/api/maps/offline`, see `backend/app/maps/offline.py`). [http]
 *  signs requests to [server] with the phone's `maps` app password. */
class OfflineApi(val server: String, private val http: OkHttpClient) {
    private val json = "application/json".toMediaType()

    data class Box(val west: Double, val south: Double, val east: Double, val north: Double)

    data class Device(val id: String, val name: String, val state: String, val build: String?, val at: String?)

    data class Area(
        val id: String,
        val name: String,
        val kind: String,
        val box: Box,
        val cells: List<String>,
        val withAddresses: Boolean,
        /** Download size with the area's own house-number choice, from the server's index; null when it has no packs. */
        val bytes: Long?,
        val addressesBytes: Long?,
        val devices: List<Device>,
        val createdAt: String?,
    )

    data class Overview(
        val enabled: Boolean,
        val ready: Boolean,
        val building: Boolean,
        val build: String?,
        val builtAt: String?,
        val search: Boolean,
        val attribution: String,
        val maxAreas: Int,
        val areas: List<Area>,
    )

    data class Estimate(val cells: List<String>, val bytes: Long?, val addressesBytes: Long?, val tooBig: Boolean, val ready: Boolean)

    data class PackFile(val cell: String?, val kind: String, val tile: Int?, val bytes: Long, val sha256: String, val url: String) {
        /** Where it's kept track of: `151_-34/map`, `l0/2763`, `base/cameras`. */
        val key: String
            get() = when (kind) {
                "l0" -> "l0/$tile"
                "cameras", "chargers" -> "base/$kind"
                else -> "$cell/$kind"
            }
        val routing: Boolean get() = kind == "route" || kind == "l0"
    }

    data class Listing(val build: String, val builtAt: String?, val files: List<PackFile>, val missing: List<String>)

    /** `GET /api/maps/offline` as the server sent it (kept on the phone for no signal); [parseOverview] reads it. */
    fun overviewJson(): JSONObject = get("/api/maps/offline")

    fun estimate(box: Box, addresses: Boolean): Estimate {
        val q = "west=${box.west}&south=${box.south}&east=${box.east}&north=${box.north}&addresses=${if (addresses) 1 else 0}"
        val j = get("/api/maps/offline/estimate?$q")
        return Estimate(j.strings("cells"), j.long("bytes"), j.long("addresses_bytes"), j.optBoolean("too_big"), j.optBoolean("ready"))
    }

    fun files(cells: Collection<String>, addresses: Boolean): Listing {
        val list = URLEncoder.encode(cells.joinToString(","), "UTF-8")
        val j = get("/api/maps/offline/files?cells=$list&addresses=${if (addresses) 1 else 0}")
        val rows = j.getJSONArray("files")
        return Listing(
            build = j.getString("build"),
            builtAt = j.text("built_at"),
            files = List(rows.length()) { i ->
                val r = rows.getJSONObject(i)
                PackFile(
                    cell = r.text("cell"),
                    kind = r.getString("kind"),
                    tile = if (r.has("tile") && !r.isNull("tile")) r.getInt("tile") else null,
                    bytes = r.getLong("bytes"),
                    sha256 = r.getString("sha256").lowercase(),
                    url = r.getString("url"),
                )
            },
            missing = j.strings("missing"),
        )
    }

    fun createView(name: String, box: Box, withAddresses: Boolean): Area = area(send("POST", "/api/maps/offline/areas",
        JSONObject().put("name", name).put("kind", "view").put("with_addresses", withAddresses)
            .put("box", JSONObject().put("west", box.west).put("south", box.south).put("east", box.east).put("north", box.north))))

    fun createAround(name: String, lat: Double, lon: Double, km: Double, withAddresses: Boolean): Area = area(send("POST", "/api/maps/offline/areas",
        JSONObject().put("name", name).put("kind", "around").put("with_addresses", withAddresses)
            .put("around", JSONObject().put("lat", lat).put("lon", lon).put("km", km))))

    fun edit(id: String, name: String? = null, withAddresses: Boolean? = null): Area {
        val body = JSONObject()
        name?.let { body.put("name", it) }
        withAddresses?.let { body.put("with_addresses", it) }
        return area(send("PATCH", "/api/maps/offline/areas/$id", body))
    }

    /** Gone, or already gone somewhere else. */
    fun delete(id: String) {
        val r = raw("DELETE", "/api/maps/offline/areas/$id", null)
        if (r.first != 204 && r.first != 404) fail(r.first, r.second)
    }

    fun report(id: String, deviceId: String, deviceName: String, state: String, build: String?, bytes: Long) {
        val body = JSONObject().put("device_id", deviceId).put("name", deviceName).put("state", state).put("bytes", bytes)
        if (build != null) body.put("build", build)
        val r = raw("PUT", "/api/maps/offline/areas/$id/device", body)
        // The area was deleted somewhere else meanwhile: nothing to report to.
        if (r.first == 404) return
        if (r.first !in 200..299) fail(r.first, r.second)
    }

    /** Where the place in the middle of a view is, for a name. */
    fun placeName(lat: Double, lon: Double): String? {
        val j = get("/api/maps/reverse?lat=$lat&lon=$lon")
        return nameFrom(j)
    }

    private fun get(path: String): JSONObject {
        val (code, text) = raw("GET", path, null)
        if (code !in 200..299) fail(code, text)
        return JSONObject(text)
    }

    private fun send(method: String, path: String, body: JSONObject): JSONObject {
        val (code, text) = raw(method, path, body)
        if (code !in 200..299) fail(code, text)
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    private fun raw(method: String, path: String, body: JSONObject?): Pair<Int, String> {
        val request = Request.Builder().url(server.trimEnd('/') + path)
            .method(method, body?.toString()?.toRequestBody(json))
            .build()
        http.newCall(request).execute().use { r -> return r.code to r.body.string() }
    }

    private fun fail(code: Int, text: String): Nothing {
        val detail = runCatching { JSONObject(text).opt("detail") as? String }.getOrNull()
        when {
            code == 401 -> throw SignedOut()
            detail != null && detail.startsWith("Offline maps aren't turned on") -> throw OffOnServer()
            detail != null && detail.startsWith("Your server is still building") -> throw StillBuilding()
            detail != null -> throw ServerSaid(code, detail)
            code >= 500 || code == 0 -> throw IOException("The server had a problem ($code). It'll try again.")
            else -> throw ServerSaid(code, "The server said no ($code).")
        }
    }

    companion object {
        private val STATES = Regex(
            "\\s*(New South Wales|Victoria|Queensland|South Australia|Western Australia|Tasmania|Northern Territory|" +
                "Australian Capital Territory|NSW|VIC|QLD|SA|WA|TAS|NT|ACT)?\\s*(\\d{4})?\\s*$",
        )

        /** A short name for an area from a reverse look-up: the town or suburb, else the place. */
        internal fun nameFrom(j: JSONObject): String? {
            val address = j.text("address")
            val town = address?.split(",")?.lastOrNull()?.replace(STATES, "")?.trim()
            if (!town.isNullOrBlank()) return town
            return j.text("name")?.takeIf { it != "Dropped pin" }
        }

        fun parseOverview(j: JSONObject): Overview {
            val areas = j.optJSONArray("areas") ?: JSONArray()
            return Overview(
                enabled = j.optBoolean("enabled", true),
                ready = j.optBoolean("ready"),
                building = j.optBoolean("building"),
                build = j.text("build"),
                builtAt = j.text("built_at"),
                search = j.optBoolean("search"),
                attribution = j.text("attribution") ?: "© OpenStreetMap contributors · Protomaps",
                maxAreas = j.optInt("max_areas", 30),
                areas = List(areas.length()) { area(areas.getJSONObject(it)) },
            )
        }

        internal fun area(j: JSONObject): Area {
            val box = j.optJSONObject("box") ?: JSONObject()
            val devices = j.optJSONArray("devices") ?: JSONArray()
            return Area(
                id = j.getString("id"),
                name = j.getString("name"),
                kind = j.optString("kind", "view"),
                box = Box(box.optDouble("west"), box.optDouble("south"), box.optDouble("east"), box.optDouble("north")),
                cells = j.strings("cells"),
                withAddresses = j.optBoolean("with_addresses", true),
                bytes = j.long("bytes"),
                addressesBytes = j.long("addresses_bytes"),
                devices = List(devices.length()) { i ->
                    val d = devices.getJSONObject(i)
                    Device(d.optString("device_id"), d.optString("name"), d.optString("state"), d.text("build"), d.text("at"))
                },
                createdAt = j.text("created_at"),
            )
        }
    }
}

internal fun JSONObject.text(key: String): String? = if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

internal fun JSONObject.long(key: String): Long? = if (!has(key) || isNull(key)) null else optLong(key)

internal fun JSONObject.strings(key: String): List<String> {
    val a = optJSONArray(key) ?: return emptyList()
    return List(a.length()) { a.getString(it) }
}

/** Sizes the way the screens say them. */
object Sizes {
    fun text(bytes: Long): String {
        val mb = bytes / 1_000_000.0
        return when {
            bytes < 1_000_000 -> "under 1 MB"
            mb < 10 -> String.format(java.util.Locale.ROOT, "%.1f MB", mb)
            mb < 1000 -> "${Math.round(mb)} MB"
            else -> String.format(java.util.Locale.ROOT, "%.1f GB", mb / 1000)
        }
    }
}
