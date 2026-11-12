"""Talk's hello: a phone's language tag with Android 14+ regional preferences
("en-AU-u-fw-mon-mu-celsius") used to be over the length limit, so the whole
hello was refused and Talk "couldn't start on this phone"."""
from __future__ import annotations

import pytest

from app.talk.protocol import Hello
from app.talk.session import _lang


@pytest.mark.parametrize(
    ("sent", "kept"),
    [
        ("en-AU-u-fw-mon-mu-celsius", "en-AU"),
        ("en-AU-u-mu-celsius", "en-AU"),
        ("en-AU", "en-AU"),
        ("zh-Hant-TW-u-ca-roc", "zh-Hant-TW"),
        ("en_GB", "en-GB"),
        ("", None),
        (None, None),
    ],
)
def test_the_hello_keeps_the_language_and_drops_regional_preferences(sent, kept):
    hello = Hello.model_validate({"type": "hello", "device": "android", "lang": sent, "tz": "Australia/Brisbane"})
    assert hello.lang == kept


def test_speech_recognition_still_gets_just_the_language():
    hello = Hello.model_validate({"type": "hello", "lang": "en-AU-u-fw-mon-mu-celsius"})
    assert _lang(hello.lang) == "en"


def test_a_time_zone_too_long_to_be_real_is_ignored_not_refused():
    hello = Hello.model_validate({"type": "hello", "tz": "x" * 80})
    assert hello.tz is None


def test_a_wrong_sample_rate_is_still_refused():
    with pytest.raises(ValueError):
        Hello.model_validate({"type": "hello", "sample_rate": 44_100})
