package org.promptly.sync.maps

import android.content.Context
import android.media.AudioManager
import android.speech.tts.TextToSpeech
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import uniffi.ferrostar.SpokenInstruction
import java.util.UUID

/** The music is turned down only while something is being said. The owner's music
 *  stayed quiet for whole trips: the navigation library asked for the music to be
 *  turned down for every direction, muted or not, and only gave it back when a
 *  sentence finished. Muted, nothing is said, so nothing ever finished. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NavVoiceTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val audio get() = shadowOf(context.getSystemService(AudioManager::class.java))

    private class Music {
        var ducks = 0
        var restores = 0
        val ducking = Ducking({ ducks++ }, { restores++ })
        val down get() = ducks > restores
    }

    private fun ready(): NavVoice = NavVoice(context).also {
        shadowOf(it.tts).onInitListener.onInit(TextToSpeech.SUCCESS)
        ShadowLooper.idleMainLooper()
    }

    private fun direction(text: String = "Turn left onto Brisbane Street") =
        SpokenInstruction(text, null, 100.0, UUID.randomUUID())

    @Test
    fun `the music comes back when the sentence finishes`() {
        val music = Music()
        music.ducking.begin("a")
        assertTrue(music.down)
        music.ducking.end("a")
        assertFalse(music.down)
        assertEquals(1, music.ducks)
        assertEquals(1, music.restores)
    }

    @Test
    fun `two sentences in a row are one dip, not two`() {
        val music = Music()
        music.ducking.begin("a")
        music.ducking.begin("b")
        music.ducking.end("a")
        assertTrue("still talking", music.down)
        music.ducking.end("b")
        assertFalse(music.down)
        assertEquals(1, music.ducks)
        assertEquals(1, music.restores)
    }

    @Test
    fun `finishing twice, or something never started, changes nothing`() {
        val music = Music()
        music.ducking.end("never")
        music.ducking.end(null)
        assertEquals(0, music.restores)
        music.ducking.begin("a")
        music.ducking.end("a")
        music.ducking.end("a")
        assertEquals(1, music.restores)
        assertFalse(music.ducking.ducked)
    }

    @Test
    fun `ending the trip gives the music back whatever was queued`() {
        val music = Music()
        music.ducking.begin("a")
        music.ducking.begin("b")
        music.ducking.endAll()
        assertFalse(music.down)
        music.ducking.endAll()
        assertEquals(1, music.restores)
        // A late "finished" from the voice engine doesn't restore twice.
        music.ducking.end("a")
        assertEquals(1, music.restores)
    }

    @Test
    fun `a muted direction never touches the music`() {
        val voice = ready()
        voice.setMuted(true)
        voice.onSpokenInstructionTrigger(direction())
        ShadowLooper.idleMainLooper()
        assertNull("asked for the music to be turned down while muted", audio.lastAudioFocusRequest)
        assertFalse(voice.ducking.ducked)
    }

    @Test
    fun `a spoken direction turns the music down, and stopping gives it back`() {
        val voice = ready()
        voice.onSpokenInstructionTrigger(direction())
        val asked = audio.lastAudioFocusRequest
        assertNotNull(asked)
        assertEquals(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK, asked!!.durationHint)
        // Cut off (muted mid-sentence, the trip ended, the assistant button).
        voice.stopAndClearQueue()
        ShadowLooper.idleMainLooper()
        assertFalse(voice.ducking.ducked)
        assertNotNull("the music was never given back", audio.lastAbandonedAudioFocusRequest)
    }

    @Test
    fun `whatever a sentence was waiting for still happens if it's cut off`() {
        val voice = ready()
        var done = 0
        voice.say("Speed camera ahead.", "x") { done++ }
        voice.stopAndClearQueue()
        ShadowLooper.idleMainLooper()
        assertEquals(1, done)
        assertFalse(voice.ducking.ducked)
    }

    @Test
    fun `a phone whose voice never starts doesn't hold the music`() {
        val voice = NavVoice(context)
        var done = 0
        voice.say("Speed camera ahead.", "x") { done++ }
        assertFalse("turned down before there was a voice to speak with", voice.ducking.ducked)
        shadowOf(voice.tts).onInitListener.onInit(TextToSpeech.ERROR)
        ShadowLooper.idleMainLooper()
        assertEquals(1, done)
        assertFalse(voice.ducking.ducked)
        assertNull(audio.lastAudioFocusRequest)
    }
}
