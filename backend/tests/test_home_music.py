"""Music by name (``app/home/music.py``, the ``home_music`` tool, the link
endpoints): one result is played only when it is plainly what was asked for,
a speaker is never guessed between two, only a home's owner links a service,
and a link shown to a person is only ever the service's own page."""
from __future__ import annotations

import asyncio

import pytest

from tests.test_home import _has_snapshot, _prepare, _turn_on, _wait, client  # noqa: F401
from tests.test_home_assistant import AREAS, BENCH, LOCK, _ctx, _dial
from tests.test_maps_timeline import _hdr, _other

WIIM = {"id": "media_player.lounge", "domain": "media_player", "name": "Lounge speaker", "state": "idle", "area": "lounge", "x": {"vol": 20, "can": ["pause", "play", "vol", "music"]}}
STUDY = {"id": "media_player.study", "domain": "media_player", "name": "Study speaker", "state": "idle", "area": "kitchen", "x": {"vol": 20, "can": ["pause", "play", "vol", "music"]}}
OLD = {"id": "media_player.tv", "domain": "media_player", "name": "TV", "state": "idle", "area": "lounge", "x": {"can": ["pause", "play"]}}

MILES = {"uri": "tidal://artist/100", "kind": "artist", "name": "Miles Davis"}
KOB = {"uri": "tidal://album/200", "kind": "album", "name": "Kind of Blue", "artist": "Miles Davis"}
KOB_REMASTER = {"uri": "tidal://album/201", "kind": "album", "name": "Kind of Blue", "artist": "Miles Davis", "version": "Legacy Edition"}
BLUE_JONI = {"uri": "tidal://album/300", "kind": "album", "name": "Blue", "artist": "Joni Mitchell"}
BLUE_WEEZER = {"uri": "tidal://album/301", "kind": "album", "name": "Blue", "artist": "Weezer"}
BLUE_SONG = {"uri": "tidal://track/302", "kind": "track", "name": "Blue", "artist": "Eiffel 65", "album": "Europop"}
YESTERDAY = {"uri": "tidal://track/400", "kind": "track", "name": "Yesterday", "artist": "The Beatles", "album": "Help!"}
YESTERDAY_2 = {"uri": "tidal://track/401", "kind": "track", "name": "Yesterday", "artist": "Boyz II Men"}
MIX = {"uri": "tidal://playlist/abc-123", "kind": "playlist", "name": "Miles Davis Essentials", "by": "TIDAL"}


# ---------------------------------------------------------------- choosing
def test_one_result_with_the_name_asked_for_is_played():
    from app.home import music

    assert music.choose([MILES, KOB, MIX], "Miles Davis") == (MILES, [])
    assert music.choose([MILES, KOB, MIX], "kind of blue") == (KOB, [])
    assert music.choose([MILES, KOB, MIX], "the album Kind of Blue") == (KOB, [])
    assert music.choose([YESTERDAY, YESTERDAY_2], "Yesterday by The Beatles") == (YESTERDAY, [])
    assert music.choose([YESTERDAY, YESTERDAY_2], "yesterday by the beatles", "track") == (YESTERDAY, [])
    assert music.choose([MILES, KOB], "something by Miles Davis") == (MILES, [])
    assert music.choose([MILES, KOB], "music by miles davis") == (MILES, [])


def test_the_same_album_listed_twice_is_one_thing():
    from app.home import music

    assert music.choose([KOB, KOB_REMASTER], "Kind of Blue") == (KOB, [])


def test_two_different_things_with_that_name_is_a_question():
    from app.home import music

    picked, ask = music.choose([BLUE_JONI, BLUE_WEEZER, BLUE_SONG], "Blue")
    assert picked is None and ask == [BLUE_JONI, BLUE_WEEZER, BLUE_SONG]
    picked, ask = music.choose([BLUE_JONI, BLUE_WEEZER, BLUE_SONG], "Blue", "album")
    assert picked is None and ask == [BLUE_JONI, BLUE_WEEZER]
    picked, ask = music.choose([YESTERDAY, YESTERDAY_2], "Yesterday")
    assert picked is None and ask == [YESTERDAY, YESTERDAY_2]
    # Said whose: no question.
    assert music.choose([BLUE_JONI, BLUE_WEEZER, BLUE_SONG], "Blue by Joni Mitchell") == (BLUE_JONI, [])


def test_nothing_with_that_name_is_a_question_never_the_first_result():
    from app.home import music

    picked, ask = music.choose([MILES, KOB, MIX], "miles")
    assert picked is None and ask == [MILES, KOB, MIX]
    picked, ask = music.choose([KOB, KOB_REMASTER, BLUE_JONI], "that blue jazz record")
    assert picked is None and len(ask) == 2  # two of a kind at most, when the kind wasn't said
    assert music.choose([], "anything") == (None, [])
    # Asked for a kind and there is exactly one of it: that one.
    assert music.choose([MILES, MIX], "miles davis essentials playlist", "playlist") == (MIX, [])


def test_what_a_box_says_is_cut_to_what_we_know():
    from app.home import music

    got = music.clean_results([
        MILES,
        {**KOB, "junk": "x" * 999, "artist": "A" * 500},
        {"uri": "http://169.254.169.254/latest", "kind": "track", "name": "Nope"},
        {"uri": "tidal://track/1?x=1", "kind": "track", "name": "Nope"},
        {"uri": "tidal://album/2", "kind": "track", "name": "Says it's something else"},
        {"uri": "tidal://track/3", "kind": "track", "name": ""},
        "nonsense",
    ])
    assert [g["uri"] for g in got] == ["tidal://artist/100", "tidal://album/200"]
    assert "junk" not in got[1] and len(got[1]["artist"]) == 120
    assert music.clean_results("nonsense") == []


def test_a_link_is_only_ever_the_services_own_page():
    from app.home import music

    good = {"state": "open", "brand": "tidal", "name": "Tidal", "flow": "abc123", "url": "https://link.tidal.com/ABCDE", "code": "ABCDE", "until": 1794878617}
    assert music.clean_link(good, "tidal") == {**good, "site": "link.tidal.com"}
    for url in (
        "https://link.tidal.com.evil.example/ABCDE",
        "https://evil.example/link.tidal.com",
        "http://link.tidal.com/ABCDE",
        "https://user@link.tidal.com/ABCDE",
        "https://link.tidal.com:8443/ABCDE",
        "javascript:alert(1)",
    ):
        assert music.clean_link({**good, "url": url}, "tidal")["state"] == "stopped", url
    assert music.clean_link({**good, "flow": "../../etc"}, "tidal")["state"] == "stopped"
    assert music.clean_link({"state": "done", "name": "Tidal", "token": "secret"}, "tidal") == {"state": "done", "brand": "tidal", "name": "Tidal"}
    assert music.clean_link(None, "tidal")["state"] == "stopped"
    assert "code" not in music.clean_link({**good, "code": "<script>"}, "tidal")


# ---------------------------------------------------------------- the tool
class Box:
    """Answers what the server asks with what a real box would say."""

    def __init__(self, box, found=None, status=None, suggest=None):
        self.box, self.found, self.status, self.suggest = box, found or [], status, suggest
        self.asked: list[tuple[str, dict]] = []
        self.task = asyncio.create_task(self._serve())

    async def _serve(self):
        while True:
            ask = await self.box.hear("req")
            self.asked.append((ask["op"], ask["args"]))
            if ask["op"] == "music.search":
                data = self.found
                if isinstance(data, dict):  # what each set of words finds
                    data = [r for r in data.get(ask["args"]["q"].lower(), []) if r["kind"] in ask["args"]["kinds"]]
                if isinstance(data, str):
                    await self.box.say({"t": "res", "id": ask["id"], "ok": False, "error": data})
                    continue
            elif ask["op"] == "music.suggest":
                data = self.suggest
                if isinstance(data, str):
                    await self.box.say({"t": "res", "id": ask["id"], "ok": False, "error": data})
                    continue
            elif ask["op"] == "music.status":
                data = self.status
            else:
                data = None
            await self.box.say({"t": "res", "id": ask["id"], "ok": True, "data": data})

    def stop(self):
        self.task.cancel()


async def _home(client, admin, who, entities):  # noqa: F811
    prepared = await _prepare(client, admin)
    home_id = (await client.post("/api/home/claim", headers=_hdr(who), json={"code": prepared["claim_code"]})).json()["home_id"]
    box, task = await _dial(prepared)
    await box.say({"t": "snapshot", "areas": AREAS, "entities": entities})
    await _wait(lambda: _has_snapshot(prepared["box"]["id"]))
    return prepared, home_id, box, task


async def test_plays_what_is_plainly_asked_for_on_the_speaker_named(user, client, db):  # noqa: F811
    from app.chat.tools.home import HomeMusicTool

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user, [BENCH, WIIM, OLD, LOCK])
    side = Box(box, [MILES, KOB, MIX])
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "Miles Davis", "target": "lounge"})
    assert result.content == "Done: Playing Miles Davis on Lounge speaker."
    assert side.asked == [
        ("music.search", {"q": "Miles Davis", "kinds": ["artist", "album", "track", "playlist"], "limit": 5}),
        ("music.play", {"entity": "media_player.lounge", "uri": "tidal://artist/100", "shuffle": False}),
    ]
    side.asked.clear()
    # No speaker said, and one that can play music: that one.
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "Kind of Blue", "kind": "album", "shuffle": True})
    assert result.content == "Done: Playing Kind of Blue, the album by Miles Davis on Lounge speaker."
    assert side.asked[0] == ("music.search", {"q": "Kind of Blue", "kinds": ["album"], "limit": 5})
    assert side.asked[1] == ("music.play", {"entity": "media_player.lounge", "uri": "tidal://album/200", "shuffle": True})
    side.stop()
    await box.hang_up()
    await task


async def test_asks_which_one_and_then_plays_the_one_chosen(user, client, db):  # noqa: F811
    from app.chat.tools.base import ToolError
    from app.chat.tools.home import HomeMusicTool

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user, [WIIM])
    side = Box(box, [BLUE_JONI, BLUE_WEEZER, BLUE_SONG])
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "Blue"})
    assert result.content.startswith("Nothing is playing yet")
    assert "Blue, the album by Joni Mitchell  (uri: tidal://album/300)" in result.content and "Weezer" in result.content
    assert [a[0] for a in side.asked] == ["music.search"]  # nothing was played
    side.asked.clear()
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "Blue by Joni Mitchell", "uri": "tidal://album/300", "target": "Lounge speaker"})
    assert result.content == "Done: Playing Blue by Joni Mitchell on Lounge speaker."
    assert side.asked == [("music.play", {"entity": "media_player.lounge", "uri": "tidal://album/300", "shuffle": False})]
    side.asked.clear()
    # A made-up uri never reaches the box.
    for bad in ("http://169.254.169.254/x", "tidal://album/300?next=http://x", "file:///etc/passwd"):
        with pytest.raises(ToolError):
            await HomeMusicTool().run(_ctx(db, user), {"uri": bad})
    assert side.asked == []
    side.found = []
    with pytest.raises(ToolError, match="Nothing called"):
        await HomeMusicTool().run(_ctx(db, user), {"query": "zzzz"})
    side.stop()
    await box.hang_up()
    await task


async def test_never_guesses_a_speaker_and_says_when_one_cant_play_music(user, client, db):  # noqa: F811
    from app.chat.tools.base import ToolError
    from app.chat.tools.home import HomeMusicTool

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user, [WIIM, STUDY, OLD])
    side = Box(box, [MILES])
    with pytest.raises(ToolError, match="Which speaker"):
        await HomeMusicTool().run(_ctx(db, user), {"query": "Miles Davis"})
    with pytest.raises(ToolError, match="More than one speaker"):
        await HomeMusicTool().run(_ctx(db, user), {"query": "Miles Davis", "target": "speaker"})
    with pytest.raises(ToolError, match="TV can't play music by name yet"):
        await HomeMusicTool().run(_ctx(db, user), {"query": "Miles Davis", "target": "TV"})
    with pytest.raises(ToolError, match="no speaker called"):
        await HomeMusicTool().run(_ctx(db, user), {"query": "Miles Davis", "target": "garage"})
    assert side.asked == []
    # A room with one speaker that plays music (the TV there can't): that one.
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "Miles Davis", "target": "lounge"})
    assert result.content == "Done: Playing Miles Davis on Lounge speaker."
    side.stop()
    await box.hang_up()
    await task


async def test_nothing_linked_says_where_to_link_it(user, client, db):  # noqa: F811
    from app.chat.tools.base import ToolError
    from app.chat.tools.home import HomeMusicTool

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user, [WIIM])
    side = Box(box, "No music service is linked to this home yet.")
    with pytest.raises(ToolError, match="owner can link Tidal"):
        await HomeMusicTool().run(_ctx(db, user), {"query": "Miles Davis"})
    side.stop()
    await box.hang_up()
    await task


async def test_only_people_in_the_home_and_a_change_waits_after_outside_content(user, client, db):  # noqa: F811
    from app.chat.tools.base import HoldForApproval, ToolError
    from app.chat.tools.home import HomeMusicTool

    await _turn_on(client, user)
    sam, ann = await _other(db), await _other(db)
    _p, _h, box, task = await _home(client, user, sam, [WIIM])
    side = Box(box, [MILES])
    for outsider in (ann, user):  # ``user`` is the admin who prepared the box
        with pytest.raises(ToolError, match="aren't in a home"):
            await HomeMusicTool().run(_ctx(db, outsider), {"query": "Miles Davis"})
    with pytest.raises(HoldForApproval):
        await HomeMusicTool().run(_ctx(db, sam, untrusted=True), {"query": "Miles Davis"})
    assert side.asked == []
    side.stop()
    await box.hang_up()
    await task


# ---------------------------------------------------------------- linking
async def test_anyone_in_the_home_sees_what_is_linked_only_the_owner_links(user, client, db):  # noqa: F811
    await _turn_on(client, user)
    sam, ann = await _other(db), await _other(db)
    prepared, home_id, box, task = await _home(client, user, sam, [WIIM])
    assert (await client.post(f"/api/home/{home_id}/members", headers=_hdr(sam), json={"username": ann.username})).status_code == 200
    base = f"/api/home/{home_id}/boxes/{prepared['box']['id']}/music"
    side = Box(box, status={"brands": [{"id": "tidal", "name": "Tidal"}], "sources": [{"id": "tidal--Ab12", "brand": "tidal", "name": "Tidal", "token": "secret"}], "speakers": ["media_player.lounge"], "extra": 1})

    for who in (sam, ann):
        got = (await client.get(base, headers=_hdr(who))).json()
        assert got == {"music": {"brands": [{"id": "tidal", "name": "Tidal"}], "sources": [{"id": "tidal--Ab12", "brand": "tidal", "name": "Tidal"}], "speakers": ["media_player.lounge"]}}
    # The admin isn't in this home: nothing.
    assert (await client.get(base, headers=_hdr(user))).status_code in (403, 404)
    side.asked.clear()
    # A member can look, not link or unlink; nor can the admin.
    for who in (ann, user):
        assert (await client.post(f"{base}/link", headers=_hdr(who), json={"brand": "tidal"})).status_code in (403, 404)
        assert (await client.delete(f"{base}/sources/tidal--Ab12", headers=_hdr(who))).status_code in (403, 404)
        assert (await client.get(f"{base}/link/tidal/abc", headers=_hdr(who))).status_code in (403, 404)
    assert side.asked == []
    assert (await client.post(f"{base}/link", headers=_hdr(sam), json={"brand": "spotify"})).status_code == 404
    assert (await client.delete(f"{base}/sources/tidal--Ab12", headers=_hdr(sam))).status_code == 200
    assert side.asked == [("music.unlink", {"source": "tidal--Ab12"})]
    side.stop()
    await box.hang_up()
    await task


async def test_linking_shows_the_services_page_and_code_and_nothing_else(user, client, db):  # noqa: F811
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home(client, user, user, [WIIM])
    base = f"/api/home/{home_id}/boxes/{prepared['box']['id']}/music"

    async def answer(data):
        ask = await box.hear("req")
        await box.say({"t": "res", "id": ask["id"], "ok": True, "data": data})
        return ask["op"], ask["args"]

    side = asyncio.create_task(answer({"state": "open", "brand": "tidal", "name": "Tidal", "flow": "f1", "url": "https://link.tidal.com/ABCDE", "code": "ABCDE", "until": 1794878617, "access_token": "never"}))
    got = (await client.post(f"{base}/link", headers=_hdr(user), json={"brand": "tidal"})).json()
    assert got == {"state": "open", "brand": "tidal", "name": "Tidal", "flow": "f1", "url": "https://link.tidal.com/ABCDE", "site": "link.tidal.com", "code": "ABCDE", "until": 1794878617}
    assert await side == ("music.link.start", {"brand": "tidal"})

    # A box that points somewhere else is not passed on.
    side = asyncio.create_task(answer({"state": "open", "flow": "f1", "url": "https://tidal.example.net/login", "code": "ABCDE"}))
    assert (await client.get(f"{base}/link/tidal/f1", headers=_hdr(user))).json()["state"] == "stopped"
    assert await side == ("music.link.get", {"flow": "f1"})

    side = asyncio.create_task(answer({"state": "done", "name": "Tidal"}))
    assert (await client.get(f"{base}/link/tidal/f1", headers=_hdr(user))).json() == {"state": "done", "brand": "tidal", "name": "Tidal"}
    await side
    await box.hang_up()
    await task


async def test_a_box_with_no_music_service_says_so_plainly(user, client, db):  # noqa: F811
    await _turn_on(client, user)
    prepared, home_id, box, task = await _home(client, user, user, [WIIM])

    async def refuse():
        ask = await box.hear("req")
        await box.say({"t": "res", "id": ask["id"], "ok": False, "error": "This box doesn't know how to do that yet. It may need updating."})

    side = asyncio.create_task(refuse())
    got = (await client.get(f"/api/home/{home_id}/boxes/{prepared['box']['id']}/music", headers=_hdr(user))).json()
    assert got == {"music": None, "why": "This box doesn't know how to do that yet. It may need updating."}
    await side
    await box.hang_up()
    await task


def test_the_tool_is_offered_with_the_other_home_tools():
    from app.chat import holds
    from app.chat.tools.registry import get_tool
    from app.talk import tools as voice

    assert get_tool("home_music").category == "home"
    assert "home_music" in voice.voice_tool_names([], device="android")
    assert not voice.is_write("home_music")
    assert holds.question("home_music", {"query": "Miles Davis", "target": "Lounge"}) == "At home: play Miles Davis on Lounge?"


# ---------------------------------------------------------------- a kind of music
JAZZ_LIST = {"uri": "tidal://playlist/jz-1", "kind": "playlist", "name": "Jazz Essentials", "by": "TIDAL"}
JAZZ_ALBUM = {"uri": "tidal://album/77", "kind": "album", "name": "Jazz", "artist": "Queen"}
JAZZ_BAND = {"uri": "tidal://artist/78", "kind": "artist", "name": "Jazz"}
CHILL = {"uri": "tidal://playlist/ch-1", "kind": "playlist", "name": "Evening Chill", "by": "TIDAL"}
ROXY = {"uri": "tidal://artist/500", "kind": "artist", "name": "Roxy Music"}
ROXY_SONG = {"uri": "tidal://track/501", "kind": "track", "name": "More Than This", "artist": "Roxy Music"}
HITS = {"uri": "tidal://playlist/hits-1", "kind": "playlist", "name": "Top Hits", "by": "TIDAL"}


def test_a_kind_of_music_is_told_from_a_named_thing():
    from app.home import music

    for said in ("some jazz", "something relaxing", "anything", "music", "", "some music", "a bit of country", "something good", "any 90s rock"):
        assert music.vague(said, plainly=True), said
    # Could be somebody's name: a kind of music only if nothing is called that.
    for said in ("90s rock music", "a jazz mix", "roxy music", "little mix", "chill vibes"):
        assert music.vague(said) and not music.vague(said, plainly=True), said
    for said in ("Miles Davis", "Kind of Blue", "something by Miles Davis", "some songs by the beatles", "Blue", "Yesterday by The Beatles"):
        assert not music.vague(said), said
    assert music.topic("some relaxing jazz music") == "relaxing jazz"
    assert music.topic("Play something relaxing, please") == "relaxing"
    assert music.topic("90s rock") == "90s rock"
    assert music.topic("music") == music.topic("something good") == music.topic("") == ""
    assert music.topic("roxy music", whole=True) == "roxy music" and music.topic("roxy music") == "roxy"
    assert music.named([ROXY, ROXY_SONG], "roxy music") and not music.named([JAZZ_LIST, MILES], "90s rock music")


def test_a_kind_of_music_picks_the_closest_fit_and_never_asks():
    from app.home import music

    # A playlist named for it, before an artist or an album that happens to share the word.
    assert music.pick_mix([JAZZ_BAND, JAZZ_ALBUM, CHILL, JAZZ_LIST], "jazz") == (JAZZ_LIST, False)
    assert music.pick_mix([MILES, MIX], "miles davis") == (MIX, False)
    # No playlist for it: the artist by that name, grown into a mix.
    assert music.pick_mix([KOB, MILES, YESTERDAY], "miles davis") == (MILES, True)
    # Nothing has the name: whatever the service put first, playlist before artist before song.
    assert music.pick_mix([YESTERDAY, MILES, CHILL], "relaxing") == (CHILL, False)
    assert music.pick_mix([YESTERDAY, MILES], "cool jazz") == (MILES, True)
    assert music.pick_mix([YESTERDAY], "sad") == (YESTERDAY, True)
    assert music.pick_mix([], "jazz") is None
    assert music.pick_called([ROXY_SONG, ROXY], "roxy music") == (ROXY, True)
    assert music.pick_called([JAZZ_LIST], "jazz music") is None
    # Just "music": the first thing the box offers.
    assert music.pick_any([YESTERDAY, MIX]) == (YESTERDAY, True)
    assert music.pick_any([MIX, MILES]) == (MIX, False)
    assert music.pick_any([]) is None
    assert music.describe_mix(MILES, True) == "a mix based on Miles Davis"
    assert music.describe_mix(YESTERDAY, True) == "a mix based on Yesterday by The Beatles"
    assert music.describe_mix(JAZZ_LIST, False) == "the playlist Jazz Essentials"


async def test_some_jazz_just_plays_and_says_what_started(user, client, db):  # noqa: F811
    from app.chat.tools.home import HomeMusicTool

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user, [WIIM, OLD])
    side = Box(box, {"jazz": [JAZZ_BAND, JAZZ_ALBUM, JAZZ_LIST], "relaxing": [YESTERDAY, MILES], "miles davis": [MILES, KOB]})
    # The model said it's a kind of music.
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "jazz", "mix": True})
    assert result.content.startswith("Done: Playing the playlist Jazz Essentials on Lounge speaker.")
    assert result.meta["spoken"] == "Playing the playlist Jazz Essentials on Lounge speaker."
    assert side.asked == [
        ("music.search", {"q": "jazz", "kinds": ["playlist", "artist", "track"], "limit": 5}),
        ("music.play", {"entity": "media_player.lounge", "uri": "tidal://playlist/jz-1", "shuffle": True}),
    ]
    side.asked.clear()
    # The words say it, whatever the model set: never Queen's album "Jazz", never a list.
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "some jazz", "target": "lounge"})
    assert "Jazz Essentials" in result.content and "Nothing is playing yet" not in result.content
    side.asked.clear()
    # No playlist for it: an artist or a song grows into a mix that doesn't end.
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "something relaxing"})
    assert result.meta["spoken"] == "Playing a mix based on Miles Davis on Lounge speaker."
    assert side.asked[-1] == ("music.play", {"entity": "media_player.lounge", "uri": "tidal://artist/100", "shuffle": False, "radio": True})
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "some Miles Davis"})
    assert result.meta["spoken"] == "Playing a mix based on Miles Davis on Lounge speaker."
    side.stop()
    await box.hang_up()
    await task


async def test_a_band_called_something_music_is_still_the_band(user, client, db):  # noqa: F811
    from app.chat.tools.home import HomeMusicTool

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user, [WIIM])
    side = Box(box, {"roxy music": [ROXY, ROXY_SONG], "90s rock music": [YESTERDAY], "90s rock": [CHILL, MILES], "roxy": [CHILL]})
    # Named, and something is called exactly that: played as before, no mix.
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "Roxy Music"})
    assert result.content == "Done: Playing Roxy Music on Lounge speaker."
    assert side.asked[-1] == ("music.play", {"entity": "media_player.lounge", "uri": "tidal://artist/500", "shuffle": False})
    # The model called it a kind of music: still the band, as a mix.
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "Roxy Music", "mix": True})
    assert result.meta["spoken"] == "Playing a mix based on Roxy Music on Lounge speaker."
    side.asked.clear()
    # Reads like a kind of music and nothing is called that: it plays, no question.
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "90s rock music"})
    assert result.meta["spoken"] == "Playing the playlist Evening Chill on Lounge speaker."
    assert [a[0] for a in side.asked] == ["music.search", "music.search", "music.search", "music.play"]
    # Two albums called "Blue" is still a question (a named thing, never a guess).
    side.found = [BLUE_JONI, BLUE_WEEZER, BLUE_SONG]
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "Blue"})
    assert result.content.startswith("Nothing is playing yet")
    side.stop()
    await box.hang_up()
    await task


async def test_just_music_plays_what_was_on_lately_or_something_everyone_knows(user, client, db):  # noqa: F811
    from app.chat.tools.base import ToolError
    from app.chat.tools.home import HomeMusicTool

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user, [WIIM])
    side = Box(box, {"top hits": [HITS]}, suggest=[YESTERDAY, MIX])
    result = await HomeMusicTool().run(_ctx(db, user), {"mix": True})
    assert result.meta["spoken"] == "Playing a mix based on Yesterday by The Beatles on Lounge speaker."
    assert side.asked == [
        ("music.suggest", {}),
        ("music.play", {"entity": "media_player.lounge", "uri": "tidal://track/400", "shuffle": False, "radio": True}),
    ]
    # Nothing played here before and nothing suggested: something everyone knows.
    side.suggest = []
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "music"})
    assert result.meta["spoken"] == "Playing the playlist Top Hits on Lounge speaker."
    # A box too old to suggest anything does the same.
    side.suggest = "This box doesn't know how to do that yet. It may need updating."
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "something good"})
    assert result.meta["spoken"] == "Playing the playlist Top Hits on Lounge speaker."
    # Nothing at all to go on: only then is it a question.
    side.found = {}
    with pytest.raises(ToolError, match="what kind of music"):
        await HomeMusicTool().run(_ctx(db, user), {"mix": True})
    with pytest.raises(ToolError, match="found nothing for “polka”"):
        await HomeMusicTool().run(_ctx(db, user), {"query": "polka", "mix": True})
    side.stop()
    await box.hang_up()
    await task


async def test_with_no_speaker_said_the_one_already_playing_is_meant(user, client, db):  # noqa: F811
    from app.chat.tools.base import ToolError
    from app.chat.tools.home import HomeMusicTool

    await _turn_on(client, user)
    _p, _h, box, task = await _home(client, user, user, [WIIM, {**STUDY, "state": "playing"}])
    side = Box(box, {"jazz": [JAZZ_LIST]})
    result = await HomeMusicTool().run(_ctx(db, user), {"query": "jazz", "mix": True})
    assert result.meta["spoken"] == "Playing the playlist Jazz Essentials on Study speaker."
    # Both playing, or neither: never a guess.
    await box.say({"t": "snapshot", "areas": AREAS, "entities": [{**WIIM, "state": "playing"}, {**STUDY, "state": "playing"}]})
    await asyncio.sleep(0.3)
    with pytest.raises(ToolError, match="Which speaker"):
        await HomeMusicTool().run(_ctx(db, user), {"query": "jazz", "mix": True})
    side.stop()
    await box.hang_up()
    await task
