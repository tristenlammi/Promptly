"""Talk's pure parts (WP-T2): cutting a streaming reply into pieces, the echo
filter and turn words, the playhead, and audio framing. No database."""
from __future__ import annotations

import struct

from app.talk import words
from app.talk.audio import FRAME_MS, PCM_FRAME_BYTES, OpusDeframer, PcmFramer, Playhead, split_seq, with_seq
from app.talk.speech import SpeechSplitter, heard_raw, to_speech


def _stream(text: str, step: int = 3) -> list[str]:
    s = SpeechSplitter()
    out = []
    for i in range(0, len(text), step):
        out += [p.text for p in s.feed(text[i : i + step])]
    out += [p.text for p in s.finish()]
    return out


def test_first_piece_is_the_first_clause_then_sentences():
    text = "You've got three things today, the dentist at nine, Sam's call at two. The bins go out tonight."
    assert _stream(text) == [
        "You've got three things today,",
        "the dentist at nine, Sam's call at two.",
        "The bins go out tonight.",
    ]


def test_a_long_first_sentence_is_cut_short_before_a_joining_word():
    text = "The dentist moved your appointment to the afternoon because the hygienist is away."
    pieces = _stream(text, step=5)
    assert pieces[0] == "The dentist moved your appointment"
    assert " ".join(pieces) == text


def test_short_replies_and_single_words_come_out_whole():
    assert _stream("Sure.") == ["Sure."]
    assert _stream("Okay, done.") == ["Okay, done."]
    assert _stream("Yes") == ["Yes"]


def test_abbreviations_and_numbers_dont_end_sentences():
    text = "Dr. Smith said 3.5 mg twice a day. That's all."
    pieces = _stream(text, step=2)
    assert pieces[-1] == "That's all."
    assert "Dr. Smith said 3.5 mg twice a day." in " ".join(pieces)


def test_markdown_citations_and_code_are_not_spoken():
    raw = "**Three** things [1], see [the list](http://x.example). ```\ncode\n``` Done."
    pieces = _stream(raw, step=4)
    joined = " ".join(pieces)
    assert "*" not in joined and "[1]" not in joined and "http" not in joined and "code\n" not in joined
    assert "(code block)" in joined
    assert to_speech("# Heading\n| a | b |") == "Heading a b"


def test_a_long_sentence_is_capped_to_one_kokoro_batch():
    long = "First thing, " + " ".join(["word"] * 80) + "."
    pieces = _stream(long, step=7)
    assert all(len(p) <= 220 for p in pieces)


def test_raw_spans_map_what_was_heard_back_to_the_reply():
    s = SpeechSplitter()
    raw = "You've got **three** things today, the dentist at nine. Bye."
    pieces = s.feed(raw) + s.finish()
    assert raw[pieces[0].raw_start : pieces[0].raw_end].strip() == "You've got **three** things today,"
    second = pieces[1]
    assert raw[: heard_raw(raw, second, 0.5)] == "You've got **three** things today, the dentist"
    assert heard_raw(raw, second, 0.0) == second.raw_start
    assert heard_raw(raw, second, 1.0) == second.raw_end


def test_echo_of_its_own_voice_isnt_the_person():
    spoken = "You've got three things today, the dentist at nine"
    assert words.real_words("you've got three things to day", spoken) == []
    assert words.real_words("the dentist at nine", spoken) == []
    assert words.real_words("the dentists at nine", spoken) == []
    assert words.real_words("wait what about friday", spoken) == ["wait", "what", "about", "friday"]
    assert words.barges_in("what about friday", spoken)
    assert not words.barges_in("you've got three things", spoken)


def test_backchannels_dont_interrupt_but_stop_words_do():
    assert not words.barges_in("mm yeah")
    assert not words.barges_in("uh-huh okay")
    assert words.barges_in("stop")
    assert words.barges_in("hold on")
    assert words.barges_in("okay, got it")
    assert words.just_stop_or_thanks("Okay, got it.")
    assert words.just_stop_or_thanks("Stop.")
    assert words.just_stop_or_thanks("Thanks, that's fine.")
    assert not words.just_stop_or_thanks("Stop, what about Friday?")


def test_goodbyes_and_the_wake_word():
    for said in ("That's all.", "Bye!", "Okay, bye, thanks.", "Stop listening.", "That's all, thanks Promptly."):
        assert words.is_goodbye(said), said
    for said in ("Bye the way, what's on?", "That's all the eggs?", "Say goodbye to Sam for me"):
        assert not words.is_goodbye(said), said
    assert words.without_wake_word("Hey Promptly, what's on today?") == "what's on today?"


def test_the_playhead_paces_and_knows_what_was_heard():
    now = [100.0]
    p = Playhead(lead_ms=300, clock=lambda: now[0])
    assert p.send_at() == 100.0
    for _ in range(15):  # 300 ms: the lead goes at once
        p.sent()
    assert p.send_at() <= 100.0 + 1e-9
    p.sent()
    assert abs(p.send_at() - 100.02) < 1e-9
    now[0] = 100.1
    assert p.heard_ms() == 100
    now[0] = 101.0  # everything sent (320 ms) has played; the client ran dry
    assert p.heard_ms() == 320
    p.sent()  # playback starts again now
    now[0] = 101.01
    assert p.heard_ms() == 330


def test_frames_on_the_wire():
    assert split_seq(with_seq(7, b"abc")) == (7, b"abc")
    assert split_seq(b"\x00\x01") is None
    d = OpusDeframer()
    stream = b"".join(struct.pack(">H", len(p)) + p for p in (b"one", b"two!", b""))
    got = []
    for i in range(0, len(stream), 3):
        got += d.push(stream[i : i + 3])
    assert got == [b"one", b"two!", b""]
    f = PcmFramer()
    frames = f.push(b"\x01" * (PCM_FRAME_BYTES * 2 + 10)) + f.flush()
    assert len(frames) == 3 and all(len(x) == PCM_FRAME_BYTES for x in frames)
    assert FRAME_MS == 20
