package org.promptly.sync.maps

import uniffi.ferrostar.DrivingSide

/**
 * Which side of the road a trip is on, for drawing roundabouts and lanes.
 *
 * The route says (Valhalla sends it with every step), and that is what's used. This is
 * only for a step that came without it: the side is worked out from where the step
 * is, else where you are, else where the server's maps are. Left is the answer only
 * when none of those is known (the app's first users drive on the left).
 */
object DrivingSides {
    /** west, south, east, north: the places that drive on the left, drawn loosely.
     *  It only has to be right for whole countries, not along their borders. */
    private val LEFT = listOf(
        doubleArrayOf(-11.0, 49.5, 2.0, 61.0), // Britain and Ireland
        doubleArrayOf(112.0, -48.0, 180.0, -9.0), // Australia and New Zealand
        doubleArrayOf(140.0, -12.0, 180.0, 0.0), // Papua New Guinea, Solomon Islands
        doubleArrayOf(176.0, -22.0, 180.0, -12.0), // Fiji
        doubleArrayOf(129.0, 30.0, 146.5, 46.0), // Japan
        doubleArrayOf(60.5, 5.5, 97.5, 37.5), // Pakistan, India, Nepal, Bhutan, Bangladesh, Sri Lanka
        doubleArrayOf(97.3, 5.5, 105.7, 20.5), // Thailand
        doubleArrayOf(95.0, -11.0, 141.0, 7.5), // Malaysia, Singapore, Brunei, Indonesia, East Timor
        doubleArrayOf(113.8, 22.1, 114.5, 22.6), // Hong Kong
        doubleArrayOf(113.5, 22.1, 113.6, 22.22), // Macau
        doubleArrayOf(11.5, -35.0, 41.0, -8.0), // Southern Africa: South Africa, Namibia, Botswana, Zimbabwe, Zambia, Malawi, Mozambique
        doubleArrayOf(29.3, -11.8, 42.0, 5.0), // Tanzania, Kenya, Uganda
        doubleArrayOf(32.2, 34.5, 34.6, 35.7), // Cyprus
        doubleArrayOf(14.1, 35.7, 14.6, 36.1), // Malta
        doubleArrayOf(-62.0, 1.0, -53.9, 8.6), // Guyana, Suriname
        doubleArrayOf(-78.5, 17.6, -76.1, 18.6), // Jamaica
    )

    /** Places inside those boxes that drive on the right, as loosely. */
    private val RIGHT_INSIDE = listOf(
        doubleArrayOf(60.5, 31.0, 69.0, 38.5), // Afghanistan
        doubleArrayOf(78.0, 30.6, 97.5, 37.5), // western China
        doubleArrayOf(102.6, 10.0, 105.7, 14.3), // Cambodia
        doubleArrayOf(11.5, -18.0, 24.0, -8.0), // Angola
        doubleArrayOf(28.8, -4.5, 30.9, -1.0), // Rwanda, Burundi
        doubleArrayOf(116.9, 4.5, 127.0, 7.5), // the southern Philippines
    )

    /** True when [lat], [lon] is somewhere that drives on the left. */
    fun leftAt(lat: Double, lon: Double): Boolean {
        fun inside(box: DoubleArray) = lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3]
        return LEFT.any(::inside) && RIGHT_INSIDE.none(::inside)
    }

    /**
     * The side for a step. [given] is what the route said. Otherwise the first known
     * place decides: [at] (the step, or you), then [bounds] (the server's maps: west,
     * south, east, north). Latitude first in [at].
     */
    fun side(given: DrivingSide?, at: Pair<Double, Double>? = null, bounds: DoubleArray? = null): DrivingSide {
        if (given != null) return given
        val where = at ?: MapStart.centre(bounds) ?: return DrivingSide.LEFT
        return if (leftAt(where.first, where.second)) DrivingSide.LEFT else DrivingSide.RIGHT
    }
}
