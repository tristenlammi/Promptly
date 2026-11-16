package org.promptly.sync.maps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraPinsTest {
    private val bruce = Camera(-26.90, 152.96, 110.0)
    private val city = Camera(-27.47, 153.02, 60.0)
    private val far = Camera(-33.87, 151.21, null)

    @Test fun `cameras are asked for by the square you are in and the ones around it`() {
        val cell = CameraPins.cell(-26.95, 152.97)
        assertEquals(cell, CameraPins.cell(-26.99, 152.99))
        val box = CameraPins.box(cell)
        assertTrue(box[0] < 152.75 + 1e-9 && box[2] > 153.24 && box[1] < -27.24 && box[3] > -26.76)
        assertEquals(listOf(bruce), CameraPins.inBox(listOf(bruce, city, far), box))
        // South of the equator and west of Greenwich the squares still count the right way.
        assertEquals(-1 to -1, CameraPins.cell(-0.1, -0.1))
    }

    @Test fun `each camera is drawn once, the trip's and the ones around you together`() {
        val shown = CameraPins.shown(listOf(bruce), listOf(bruce.copy(maxSpeed = null), city), -26.95 to 152.97)
        assertEquals(listOf(bruce, city), shown)
        assertEquals(emptyList<Camera>(), CameraPins.shown(emptyList(), emptyList(), null))
    }

    @Test fun `with too many to draw, the nearest are kept`() {
        val many = List(CameraPins.MOST + 50) { Camera(-27.0 - it * 0.001, 153.0, null) }
        val shown = CameraPins.shown(emptyList(), many, -27.0 to 153.0)
        assertEquals(CameraPins.MOST, shown.size)
        assertTrue(shown.all { it.lat > -27.0 - CameraPins.MOST * 0.001 - 1e-9 })
    }

    @Test fun `the map is given points, longitude first`() {
        assertEquals(
            "{\"type\":\"FeatureCollection\",\"features\":[{\"type\":\"Feature\",\"properties\":{},\"geometry\":{\"type\":\"Point\",\"coordinates\":[152.96,-26.9]}}]}",
            CameraPins.geoJson(listOf(bruce)),
        )
        assertEquals("{\"type\":\"FeatureCollection\",\"features\":[]}", CameraPins.geoJson(emptyList()))
    }
}
