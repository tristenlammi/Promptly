"""Text pieces and Opus framing for /tts/stream (WP-T1). No model needed.

    docker run --rm -v "$PWD/tts:/src" -w /src promptly-tts:<tag> \
        sh -c "pip install -q pytest && python -m pytest -q tests/test_streaming.py"
"""
from __future__ import annotations

import numpy as np
import pytest

import streaming
from streaming import split_pieces


def texts(text: str, **kw) -> list[str]:
    return [p.text for p in split_pieces(text, **kw)]


def test_a_short_reply_is_one_piece():
    assert texts("Added.") == ["Added."]
    assert texts("The dentist is at nine.") == ["The dentist is at nine."]


def test_the_first_clause_goes_first():
    assert texts("You've got three things today, the dentist at nine and Sam at two.") == [
        "You've got three things today,",
        "the dentist at nine and Sam at two.",
    ]


def test_a_long_first_sentence_without_a_comma_is_cut_before_a_joining_word():
    pieces = texts("The dentist appointment is on Thursday at nine in the morning so leave early.")
    assert pieces[0] == "The dentist appointment is on Thursday"
    assert " ".join(pieces) == "The dentist appointment is on Thursday at nine in the morning so leave early."
    assert len(pieces[0].split()) <= 6


def test_a_long_first_sentence_with_nowhere_nice_is_cut_after_six_words():
    pieces = texts("Grab your umbrella tomorrow because rain arrives early everywhere around here.")
    assert len(pieces[0].split()) <= 6
    assert " ".join(pieces).startswith("Grab your umbrella tomorrow")


def test_a_leading_word_and_comma_is_not_its_own_piece():
    assert texts("Okay, you've got three things today and they're all short.")[0] != "Okay,"


def test_then_whole_sentences():
    pieces = texts("Sure. The dentist is at nine on Thursday. Sam's call is at two. Anything else?")
    assert pieces == ["Sure.", "The dentist is at nine on Thursday.", "Sam's call is at two.", "Anything else?"]


def test_abbreviations_dont_end_a_sentence():
    assert texts("Dr. Smith is at nine. Then lunch.", first_clause=False) == ["Dr. Smith is at nine.", "Then lunch."]


def test_first_clause_can_be_turned_off():
    assert texts("You've got three things today, the dentist at nine and Sam at two.", first_clause=False) == [
        "You've got three things today, the dentist at nine and Sam at two."
    ]


def test_every_piece_fits_one_kokoro_batch():
    long = "word " * 200 + "and then, after all of that, " + "more " * 150 + "done."
    pieces = texts(long)
    assert all(len(p) <= streaming.MAX_PIECE_CHARS for p in pieces)
    assert " ".join(pieces).split() == long.split()


def test_gaps_between_pieces_but_not_after_the_last():
    pieces = split_pieces("You've got three things today, the dentist at nine. Then Sam.")
    assert [p.gap_ms for p in pieces] == [streaming.GAP_AFTER_CLAUSE_MS, streaming.GAP_AFTER_SENTENCE_MS, 0]


@pytest.mark.parametrize("text", ["", "   ", "...", "\n\n"])
def test_nothing_to_say(text):
    assert split_pieces(text) == []


def test_opus_framing_round_trip():
    import opuslib

    sr = streaming.SAMPLE_RATE
    t = np.arange(int(sr * 1.03)) / sr  # not a whole number of frames
    tone = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    framer = streaming.OpusFramer()
    data = framer.push(tone[:7000]) + framer.push(tone[7000:]) + framer.flush()
    packets = streaming.read_framed(data)
    assert len(packets) == framer.packets == -(-len(tone) // streaming.FRAME_SAMPLES)
    decoder = opuslib.Decoder(sr, 1)
    pcm = b"".join(decoder.decode(p, streaming.FRAME_SAMPLES) for p in packets)
    out = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
    assert abs(len(out) - len(tone)) < streaming.FRAME_SAMPLES
    # Opus keeps the tone: same loudness, within a dB or so.
    mid = slice(4800, 19200)
    rms_in, rms_out = np.sqrt(np.mean(tone[mid] ** 2)), np.sqrt(np.mean(out[mid] ** 2))
    assert abs(20 * np.log10(rms_out / rms_in)) < 1.5
