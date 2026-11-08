package org.promptly.sync.maps.offline

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URLEncoder

/** The map's styles, fonts and sprites: the server's public `/map-assets/` (the
 *  same files the web map uses, from `frontend/public/map-assets`), kept on the
 *  phone so the offline map can draw with no server. They change with app
 *  releases, not map builds, so each is checked with its ETag on every download
 *  run and fetched again only when it changed. */
object MapAssets {
    /** Every file in `frontend/public/map-assets` (MapAssetsTest checks this list against the folder). */
    val FILES: List<String> = buildList {
        add("README.txt")
        add("countries-110m.geojson")
        for (font in listOf("Noto Sans Italic", "Noto Sans Medium", "Noto Sans Regular")) {
            for (range in listOf("0-255", "1024-1279", "256-511", "512-767", "768-1023", "7680-7935", "8192-8447")) {
                add("fonts/$font/$range.pbf")
            }
        }
        add("fonts/OFL.txt")
        for (theme in listOf("dark", "light")) {
            add("sprites/$theme.json")
            add("sprites/$theme.png")
            add("sprites/$theme@2x.json")
            add("sprites/$theme@2x.png")
        }
        add("style-dark.json")
        add("style-light.json")
    }

    /** Fetches what's new or changed into [dir]. Returns how many files changed. */
    fun sync(server: String, dir: File, http: OkHttpClient, stopped: () -> Boolean = { false }): Int {
        dir.mkdirs()
        val tagsFile = File(dir, ".etags.json")
        val tags = runCatching { JSONObject(tagsFile.readText()) }.getOrElse { JSONObject() }
        var changed = 0
        for (path in FILES) {
            if (stopped()) throw Stopped()
            val dest = File(dir, path)
            val url = server.trimEnd('/') + "/map-assets/" + path.split('/').joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
            val request = Request.Builder().url(url).apply {
                val tag = tags.optString(path)
                if (tag.isNotEmpty() && dest.isFile) header("If-None-Match", tag)
            }.build()
            http.newCall(request).execute().use { r ->
                when (r.code) {
                    304 -> Unit
                    200 -> {
                        dest.parentFile?.mkdirs()
                        val tmp = File(dest.parentFile, dest.name + ".new")
                        tmp.outputStream().use { out -> r.body.byteStream().copyTo(out) }
                        if (tmp.length() == 0L) {
                            tmp.delete()
                            throw IOException("The server sent an empty map file ($path).")
                        }
                        if (!tmp.renameTo(dest)) {
                            dest.delete()
                            if (!tmp.renameTo(dest)) throw IOException("Couldn't save a map file.")
                        }
                        r.header("ETag")?.let { tags.put(path, it) } ?: tags.remove(path)
                        changed++
                    }
                    else -> throw IOException("The server didn't send the map's $path (${r.code}).")
                }
            }
        }
        tagsFile.writeText(tags.toString())
        return changed
    }

    /** All of them are here. */
    fun complete(dir: File): Boolean = FILES.all { File(dir, it).isFile }
}
