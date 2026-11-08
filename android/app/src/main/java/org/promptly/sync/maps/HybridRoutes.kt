package org.promptly.sync.maps

import android.content.Context
import com.stadiamaps.ferrostar.core.CustomRouteProvider
import com.stadiamaps.ferrostar.core.InvalidStatusCodeException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.promptly.sync.maps.offline.Cells
import org.promptly.sync.maps.offline.LocalRouter
import org.promptly.sync.maps.offline.Offline
import uniffi.ferrostar.Route
import uniffi.ferrostar.RouteRequest
import uniffi.ferrostar.UserLocation
import uniffi.ferrostar.Waypoint
import uniffi.ferrostar.createOsrmResponseParser
import uniffi.ferrostar.createValhallaRequestGenerator
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Where a route came from. */
enum class RouteSource { SERVER, PHONE }

/** A Valhalla route request as Ferrostar's own generator made it. */
class RoutePost(val url: String, val body: ByteArray, val headers: Map<String, String> = emptyMap())

/** Your server's answer was an HTTP error. */
class HttpStatus(val code: Int) : IOException("Server said $code")

/** Asks your server for a route; throws [HttpStatus] or an [IOException]. */
fun interface RouteServer {
    fun post(post: RoutePost, reroute: Boolean, timeoutMillis: Long): ByteArray
}

/** Asks the phone for a route; throws [LocalRouter.MissingSquares] or [LocalRouter.NoRoute]. */
fun interface PhoneRouter {
    fun route(body: String, cells: Collection<String>): String
}

/** No route from the server (no signal, or it's down), and none from the phone either. */
class OfflineRouteUnavailable(val outside: Boolean, val missing: List<String>, cause: Exception?) :
    IOException(if (outside) "This trip goes outside your offline areas" else "No route within your offline areas", cause)

/**
 * The server first, the phone when it can't answer. A route request (built once, by
 * Ferrostar's Valhalla generator) goes to your server with a [timeoutMillis] limit;
 * if that fails for want of a connection, or the server's down, the same request goes
 * to Valhalla on the phone, when the downloaded squares cover every point of the
 * trip. "No route" from the server (400, 422) is an answer, and stays one.
 *
 * Plain code, so the order, the timeout and the messages are tested on the JVM.
 */
class HybridRouting(
    private val server: RouteServer?,
    private val phone: () -> PhoneRouter?,
    private val timeoutMillis: Long = SERVER_TIMEOUT_MILLIS,
) {
    class Answer(val bytes: ByteArray, val source: RouteSource, val serverProblem: Exception?)

    fun answer(post: RoutePost, cells: Collection<String>, reroute: Boolean): Answer {
        var problem: Exception? = null
        if (server != null) {
            try {
                return Answer(server.post(post, reroute, timeoutMillis), RouteSource.SERVER, null)
            } catch (e: HttpStatus) {
                if (e.code == 400 || e.code == 422) throw InvalidStatusCodeException(e.code)
                problem = e
            } catch (e: IOException) {
                problem = e
            }
        }
        val local = phone() ?: throw OfflineRouteUnavailable(true, cells.toList(), problem)
        return try {
            Answer(local.route(String(post.body), cells).toByteArray(), RouteSource.PHONE, problem)
        } catch (e: LocalRouter.MissingSquares) {
            throw OfflineRouteUnavailable(true, e.cells, problem ?: e)
        } catch (e: LocalRouter.NoRoute) {
            throw OfflineRouteUnavailable(false, emptyList(), problem ?: e)
        }
    }

    companion object {
        /** How long the server gets before the phone answers instead. */
        const val SERVER_TIMEOUT_MILLIS = 6_000L

        /** The squares a trip's points are in. */
        fun cellsOf(points: List<Pair<Double, Double>>): List<String> = points.map { (lat, lon) -> Cells.of(lat, lon) }.distinct()
    }
}

/** Your server's `/api/maps/navigate/route`, through this phone's sign-in. */
class OkHttpRouteServer(private val client: (Long) -> OkHttpClient) : RouteServer {
    override fun post(post: RoutePost, reroute: Boolean, timeoutMillis: Long): ByteArray {
        val call = Request.Builder()
            .url(post.url)
            .post(post.body.toRequestBody(JSON))
            .apply {
                post.headers.forEach { (k, v) -> header(k, v) }
                if (reroute) header(ServerRoutes.REROUTE_HEADER, "1")
            }
            .build()
        val c = client(timeoutMillis).newBuilder()
            .connectTimeout(minOf(timeoutMillis, 4_000L), TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
            .callTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
            .build()
        c.newCall(call).execute().use { r ->
            if (!r.isSuccessful) throw HttpStatus(r.code)
            return r.body.bytes()
        }
    }

    private companion object {
        val JSON = "application/json".toMediaType()
    }
}

/**
 * Turn-by-turn routes for the one navigation core (phone and car), with the trip's
 * options in hand: from your server, or from the phone's offline areas when the
 * server can't be reached. Ferrostar asks here by itself after a wrong turn, so those
 * reroutes come from the phone too when there's no signal.
 */
class HybridRouteProvider(
    private val app: Context,
    private val onAnswer: (RouteSource, Boolean) -> Unit = { _, _ -> },
    private val onUnavailable: (OfflineRouteUnavailable, Boolean) -> Unit = { _, _ -> },
) : CustomRouteProvider {
    @Volatile
    var options: TripOptions = TripOptions()

    private val parser by lazy { createOsrmResponseParser(6u) }
    private val routing = HybridRouting(
        server = OkHttpRouteServer { ms -> Maps.client(app, maxOf(1L, ms / 1000)) },
        phone = { PhoneRouter { body, cells -> Offline.router(app).route(body, cells) } },
    )

    /** Ferrostar's own call: only after you've left the route. */
    override suspend fun getRoutes(userLocation: UserLocation, waypoints: List<Waypoint>): List<Route> =
        fetch(userLocation, waypoints, reroute = true)

    /** A route you asked for: starting a trip, adding a stop, taking a faster way. */
    suspend fun fetch(userLocation: UserLocation, waypoints: List<Waypoint>, reroute: Boolean = false): List<Route> = withContext(Dispatchers.IO) {
        val wanted = options
        // With no server set up the request still needs an address; only the phone answers it.
        val server = Maps.server(app)
        val endpoint = (server ?: "https://promptly.invalid") + "/api/maps/navigate/route"
        val generator = createValhallaRequestGenerator(endpoint, ServerRoutes.profileOf(wanted), ServerRoutes.requestOptions(wanted).toString())
        val request = generator.generateRequest(userLocation, waypoints) as? RouteRequest.HttpPost
            ?: throw IOException("Unexpected route request")
        val points = listOf(userLocation.coordinates.lat to userLocation.coordinates.lng) + waypoints.map { it.coordinate.lat to it.coordinate.lng }
        val answer = try {
            (if (server == null) HybridRouting(null, { PhoneRouter { b, c -> Offline.router(app).route(b, c) } }) else routing)
                .answer(RoutePost(request.url, request.body, request.headers), HybridRouting.cellsOf(points), reroute)
        } catch (e: OfflineRouteUnavailable) {
            onUnavailable(e, reroute)
            throw e
        }
        val routes = parser.parseResponse(answer.bytes)
        onAnswer(answer.source, reroute)
        routes
    }
}
