"""Porch photos: signed ``porch_*`` links that stop working when access
ends, a photo trashed in Photos dropping out of its post, a post's own crop
or filter (rendered for that post only, a new URL when it changes), group
covers, and a Porch photo never showing in another person's Drive, file
search or "Shared with me"."""
from __future__ import annotations

import io
import uuid
from datetime import datetime, timezone

from PIL import Image
from sqlalchemy import text

from tests.porch_kit import (  # noqa: F401 — fixtures
    H, client, group, jpeg, members_of, mpath, ok, people, photo, post_photos, quiet, root, say, upload,
)


async def _get(client, url, **kw):
    return await client.get(mpath(url), **kw)


async def test_links_work_while_you_can_see_the_post_and_die_after(client, db, people):
    ann, bob, cat, dan = people
    fam = await members_of(client, ann, "Family", [bob])
    data = jpeg((1200, 900))
    fid = await photo(client, ann, "beach.jpg", data)
    post = await post_photos(client, ann, [fam], [{"file_id": fid, "alt_text": "The beach"}], "Noosa")
    seen = await ok(await client.get(f"/api/porch/posts/{post['id']}", headers=H(bob)))
    m = seen["media"][0]
    assert m["kind"] == "image" and m["alt_text"] == "The beach" and (m["width"], m["height"]) == (1200, 900)
    assert m["thumbhash"] and m["state"] == "ready"

    tile = await _get(client, m["thumb"])
    assert tile.status_code == 200 and tile.headers["content-type"] == "image/webp"
    assert Image.open(io.BytesIO((await _get(client, m["preview"])).content)).size == (1200, 900)
    full = await _get(client, m["full"])
    assert full.status_code == 200 and full.content == data and full.headers["content-disposition"].startswith("attachment;")
    # Behind nginx: the library's own rendition, by X-Accel-Redirect.
    acc = await _get(client, m["thumb"], headers={"X-Promptly-Accel": "1"})
    assert acc.headers["x-accel-redirect"] == f"/_renditions/{fid}/thumb.webp" and acc.content == b""
    acc = await _get(client, m["full"], headers={"X-Promptly-Accel": "1"})
    assert acc.headers["x-accel-redirect"].startswith("/_blobs/")

    # The link names the post's photo, not the file: a forged one for the
    # file itself doesn't open it.
    from app.files import media_urls

    forged = media_urls.sign(uuid.UUID(fid), bob.id, bob.token_version, "porch_thumb", 1)
    assert (await _get(client, forged)).status_code == 404

    # Bob leaves Family: the same links stop working at once.
    await ok(await client.delete(f"/api/porch/groups/{fam}/members/{bob.id}", headers=H(bob)), 204)
    for k in ("thumb", "preview", "full"):
        assert (await _get(client, m[k])).status_code == 404, k
    # Ann's own links work until the post is deleted.
    mine = (await ok(await client.get(f"/api/porch/posts/{post['id']}", headers=H(ann))))["media"][0]
    assert (await _get(client, mine["thumb"])).status_code == 200
    await ok(await client.delete(f"/api/porch/posts/{post['id']}", headers=H(ann)), 204)
    assert (await _get(client, mine["thumb"])).status_code == 404

    # Signing out everywhere ends links too.
    other = await post_photos(client, ann, [fam], [fid])
    link = other["media"][0]["thumb"]
    from app.auth.models import User

    me = await db.get(User, ann.id)
    me.token_version += 1
    await db.commit()
    assert (await _get(client, link)).status_code == 404


async def test_a_trashed_photo_drops_out_of_its_post(client, db, people):
    from app.files.models import UserFile

    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    a, b = [await photo(client, ann, f"IMG_{i}.jpg") for i in range(2)]
    post = await post_photos(client, ann, [fam], [a, b])
    links = [m["thumb"] for m in (await ok(await client.get(f"/api/porch/posts/{post['id']}", headers=H(bob))))["media"]]

    row = await db.get(UserFile, uuid.UUID(a))
    row.trashed_at = datetime.now(timezone.utc)
    await db.commit()
    got = await ok(await client.get(f"/api/porch/posts/{post['id']}", headers=H(bob)))
    assert len(got["media"]) == 1 and got["photo_removed"] is False
    assert (await _get(client, links[0])).status_code == 404
    assert (await _get(client, links[1])).status_code == 200

    # All gone: "Photo removed". Restored: back again.
    rb = await db.get(UserFile, uuid.UUID(b))
    rb.trashed_at = datetime.now(timezone.utc)
    await db.commit()
    got = await ok(await client.get(f"/api/porch/posts/{post['id']}", headers=H(bob)))
    assert got["media"] == [] and got["photo_removed"] is True
    rb.trashed_at = None
    await db.commit()
    assert len((await ok(await client.get(f"/api/porch/posts/{post['id']}", headers=H(bob))))["media"]) == 1

    # Purged for good: the media row goes with the file.
    await db.execute(text("DELETE FROM files WHERE id = :f"), {"f": uuid.UUID(a)})
    await db.commit()
    n = await db.scalar(text("SELECT count(*) FROM porch_post_media WHERE post_id = :p"), {"p": uuid.UUID(post["id"])})
    assert n == 1


async def test_a_posts_own_crop_and_filter(client, db, people):
    from app.files.derivatives import derived_dir

    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    fid = await photo(client, ann, "wide.jpg", jpeg((1200, 900)))
    plain = await post_photos(client, ann, [fam], [fid])
    post = await post_photos(client, ann, [fam], [{"file_id": fid, "edit": {"crop": {"x": 0, "y": 0, "w": 0.5, "h": 1}, "markup": [{"type": "pen"}]}}])
    m = post["media"][0]
    assert m["edit"]["crop"] == {"x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0} and m["edit"]["markup"] == []  # markup stays in Photos
    assert (m["width"], m["height"]) == (600, 900) and m["edited"] is True

    seen = (await ok(await client.get(f"/api/porch/posts/{post['id']}", headers=H(bob))))["media"][0]
    assert seen["edit"] is None  # only the author gets the ops back
    prev = await _get(client, seen["preview"])
    assert prev.status_code == 200 and Image.open(io.BytesIO(prev.content)).size == (600, 900)
    assert (derived_dir(fid) / f"porch-{m['id']}.preview.webp").is_file()
    acc = await _get(client, seen["thumb"], headers={"X-Promptly-Accel": "1"})
    assert acc.headers["x-accel-redirect"] == f"/_renditions/{fid}/porch-{m['id']}.thumb.webp"
    full = await _get(client, seen["full"])
    assert full.headers["content-type"] == "image/jpeg" and Image.open(io.BytesIO(full.content)).size == (600, 900)
    assert full.headers["content-disposition"].startswith("attachment;") and "wide.jpg" in full.headers["content-disposition"].replace("%2E", ".")

    # The library photo isn't changed, nor is another post of it.
    assert (await db.scalar(text("SELECT count(*) FROM photo_edits"))) == 0
    other = (await ok(await client.get(f"/api/porch/posts/{plain['id']}", headers=H(bob))))["media"][0]
    assert Image.open(io.BytesIO((await _get(client, other["preview"])).content)).size == (1200, 900)
    lib = await ok(await client.get(f"/api/files/{fid}/signed-urls", headers=H(ann)))
    assert Image.open(io.BytesIO((await client.get(mpath(lib["preview"]))).content)).size == (1200, 900)

    # A new look: a new URL, made again.
    got = await ok(await client.patch(f"/api/porch/posts/{post['id']}", headers=H(ann), json={
        "media": [{"id": m["id"], "edit": {"saturation": -1}}],
    }))
    m2 = got["media"][0]
    assert m2["id"] == m["id"] and m2["preview"] != m["preview"] and (m2["width"], m2["height"]) == (1200, 900)
    img = Image.open(io.BytesIO((await _get(client, m2["preview"])).content)).convert("RGB")
    r_, g_, b_ = img.getpixel((10, 10))
    assert img.size == (1200, 900) and abs(r_ - g_) < 8 and abs(g_ - b_) < 8  # Mono

    # No edit any more: the library's own picture, and the renders go.
    got = await ok(await client.patch(f"/api/porch/posts/{post['id']}", headers=H(ann), json={"media": [{"id": m["id"]}]}))
    assert got["media"][0]["edited"] is False and got["media"][0]["edit"] is None
    assert not (derived_dir(fid) / f"porch-{m['id']}.preview.webp").exists()
    acc = await _get(client, got["media"][0]["preview"], headers={"X-Promptly-Accel": "1"})
    assert acc.headers["x-accel-redirect"] == f"/_renditions/{fid}/preview.webp"


async def test_a_porch_photo_never_shows_in_another_persons_files(client, db, people):
    from app.files.access import can_read

    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    fid = await photo(client, ann, "porchonly.jpg")
    await post_photos(client, ann, [fam], [fid], "for family")
    assert not await can_read(db, uuid.UUID(fid), bob.id)
    assert (await client.get(f"/api/files/{fid}", headers=H(bob))).status_code == 404
    assert (await client.get(f"/api/files/{fid}/signed-urls", headers=H(bob))).status_code == 404
    assert (await client.get(f"/api/files/{fid}/download", headers=H(bob))).status_code == 404
    found = await client.get("/api/files/search", headers=H(bob), params={"q": "porchonly", "scope": "shared"})
    assert fid not in found.text
    found = await client.get("/api/files/search", headers=H(bob), params={"q": "porchonly"})
    assert fid not in found.text
    shared = await client.get("/api/files/browse", headers=H(bob), params={"scope": "shared", "shared": "with_me"})
    assert shared.status_code == 200 and fid not in shared.text
    timeline = await client.get("/api/photos/timeline", headers=H(bob))
    assert fid not in timeline.text


async def test_videos_play_through_post_links(client, db, people, tmp_path):
    import subprocess

    ann, bob, *_ = people
    fam = await members_of(client, ann, "Family", [bob])
    p = tmp_path / "clip.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(p)],
        check=True,
    )
    fid = await upload(client, ann, "clip.mp4", p.read_bytes(), "video/mp4")
    from app.files.media_pipeline import ingest

    await ingest(fid)
    post = await post_photos(client, ann, [fam], [fid])
    m = (await ok(await client.get(f"/api/porch/posts/{post['id']}", headers=H(bob))))["media"][0]
    assert m["kind"] == "video" and m["poster"] and m["video"] and m["thumb"] is None and m["duration_ms"]
    poster = await _get(client, m["poster"])
    assert poster.status_code == 200 and poster.headers["content-type"] == "image/webp"
    v = await _get(client, m["video"], headers={"Range": "bytes=0-99"})
    assert v.status_code == 206 and v.headers["content-type"] == "video/mp4"
    # A video's thumb link (if someone made one up) isn't a thing.
    from app.files import media_urls

    fake = media_urls.sign(uuid.UUID(m["id"]), bob.id, bob.token_version, "porch_thumb", 1)
    assert (await _get(client, fake)).status_code == 404


async def test_group_covers(client, db, people):
    ann, bob, cat, dan = people
    pub = await group(client, ann, "Fishing", "public")
    priv = await group(client, ann, "Family")
    fid = await photo(client, ann, "cover.jpg")
    bobs = await photo(client, bob, "bobs.jpg")
    assert (await client.patch(f"/api/porch/groups/{pub}", headers=H(ann), json={"cover_file_id": bobs})).status_code == 400
    for gid in (pub, priv):
        await ok(await client.patch(f"/api/porch/groups/{gid}", headers=H(ann), json={"cover_file_id": fid}))
    # An outsider sees a public group's cover (it's part of its outline)…
    outline = await ok(await client.get(f"/api/porch/groups/{pub}", headers=H(dan)))
    assert (await _get(client, outline["cover_url"])).status_code == 200
    # …but a private group's cover link, even if it leaked, is a 404.
    from app.files import media_urls

    leaked = media_urls.sign(uuid.UUID(priv), dan.id, dan.token_version, "porch_cover", 1)
    assert (await _get(client, leaked)).status_code == 404
    mine = await ok(await client.get(f"/api/porch/groups/{priv}", headers=H(ann)))
    assert (await _get(client, mine["cover_url"])).status_code == 200
    await ok(await client.patch(f"/api/porch/groups/{pub}", headers=H(ann), json={"cover_file_id": None}))
    assert (await ok(await client.get(f"/api/porch/groups/{pub}", headers=H(dan))))["cover_url"] is None
