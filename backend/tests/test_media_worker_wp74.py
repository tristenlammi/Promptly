"""The media worker (WP-7.4): renditions for photos and videos — WebP grid
tiles and previews, video posters, a web-playable MP4 (copied when it
already is one, transcoded when not), ThumbHash placeholders — on its own
queue, with the row as the source of truth and a sweep that recovers."""
from __future__ import annotations

import base64
import io
import subprocess
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from PIL import Image

import app.files.imaging  # noqa: F401


@pytest.fixture
def root(tmp_path, monkeypatch):
    from app.files import storage

    monkeypatch.setattr(storage, "UPLOAD_ROOT", tmp_path.resolve())
    return tmp_path


@pytest.fixture
def queued(monkeypatch):
    """Uploads queue onto the media queue; collect, run on demand."""
    from app.tasks import queue

    ids: list = []

    async def collect(file_id):
        ids.append(file_id)

    monkeypatch.setattr(queue, "enqueue_media", collect)
    return ids


@pytest.fixture
async def client(db, root, queued):
    from app import rate_limit
    from app.main import app

    rate_limit._settings.RATE_LIMIT_ENABLED = False
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        rate_limit._settings.RATE_LIMIT_ENABLED = True


def _auth(user):
    from app.auth.utils import create_access_token

    return {"Authorization": f"Bearer {create_access_token(user.id, token_version=user.token_version)}"}


def _jpeg(size=(3000, 2000), orientation: int | None = None) -> bytes:
    im = Image.new("RGB", size)
    # Left half red, right half blue — so we can tell which way up it is.
    im.paste((220, 30, 30), (0, 0, size[0] // 2, size[1]))
    im.paste((30, 60, 220), (size[0] // 2, 0, size[0], size[1]))
    buf = io.BytesIO()
    exif = Image.Exif()
    if orientation:
        exif[0x0112] = orientation
    im.save(buf, format="JPEG", quality=85, exif=exif.tobytes())
    return buf.getvalue()


def _video(tmp_path, name: str, *codec: str) -> bytes:
    p = tmp_path / f"src-{uuid.uuid4().hex}-{name}"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=640x360:rate=15",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", *codec, str(p)],
        check=True,
    )
    return p.read_bytes()


async def _upload(client, user, name, data, mime):
    r = await client.post("/api/files/", files={"file": (name, data, mime)}, data={"scope": "mine"}, headers=_auth(user))
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _probe(path) -> dict:
    import json

    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


# ---------------------------------------------------------------- ThumbHash


# Made by the reference encoder (the ``thumbhash`` npm package the frontend
# decodes with) from the same pixels — the port must match bit for bit.
_REFERENCE = [
    (64, 48, False, "4wYGPYKvJGlYFHqFlXl4d4BkJ49W"),
    (37, 90, False, "owYGKwJ8fnBgVWh4cXA3yq8="),
    (100, 100, True, "X/iFJQAHr5aqlmloeFBVZuYJRUXBwVQTTw=="),
    (13, 7, True, "4NKFG4ImwJaXh4jApviAdnB3c3iHeHg="),
    (100, 61, False, "HwgKVIKPiFd6Zzd2doiAdYdvkA=="),
]


@pytest.mark.parametrize("w,h,alpha,expected", _REFERENCE)
def test_thumbhash_matches_the_reference_encoder(w, h, alpha, expected):
    from app.files.thumbhash import rgba_to_thumbhash

    px = bytearray(w * h * 4)
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            px[i] = (x * 7 + y * 3) % 256
            px[i + 1] = (x * x + y * 5) % 256
            px[i + 2] = ((255 - x * 2 - y) % 256) & 255
            px[i + 3] = ((x * 11 + y * 13) % 256) if alpha else 255
    assert base64.b64encode(rgba_to_thumbhash(w, h, bytes(px))).decode() == expected


# ---------------------------------------------------------------- photos


@pytest.mark.asyncio
async def test_a_photo_gets_upright_webp_renditions_and_a_placeholder(client, db, user, queued):
    from app.files.derivatives import rendition_path
    from app.files.media_pipeline import ingest
    from app.files.models import FileMedia

    # A landscape sensor image the camera says to rotate 90° (EXIF 6).
    fid = await _upload(client, user, "IMG.jpg", _jpeg((3000, 2000), orientation=6), "image/jpeg")
    assert queued == [uuid.UUID(fid)]
    assert await ingest(fid) == "ready"
    media = await db.get(FileMedia, uuid.UUID(fid), populate_existing=True)
    r = media.renditions
    assert (r["preview.webp"]["width"], r["preview.webp"]["height"]) == (960, 1440)  # upright, ≤1440
    assert max(r["thumb.webp"]["width"], r["thumb.webp"]["height"]) == 320
    assert media.derived_bytes == sum(v["bytes"] for v in r.values())
    assert media.thumbhash and len(base64.b64decode(media.thumbhash)) <= 30
    with Image.open(rendition_path(fid, "preview.webp")) as im:
        assert im.format == "WEBP" and im.size == (960, 1440)

    t = await client.get(f"/api/files/{fid}/thumbnail", headers=_auth(user))
    assert t.status_code == 200 and t.headers["content-type"] == "image/webp"
    again = await client.get(f"/api/files/{fid}/thumbnail", headers={**_auth(user), "If-None-Match": t.headers["etag"]})
    assert again.status_code == 304
    big = await client.get(f"/api/files/{fid}/thumbnail?size=1024", headers=_auth(user))
    assert Image.open(io.BytesIO(big.content)).size == (960, 1440)

    # The grid gets the placeholder with the listing.
    listing = (await client.get("/api/files/browse?scope=mine", headers=_auth(user))).json()
    [row] = [f for f in listing["files"] if f["id"] == fid]
    assert row["thumbhash"] == media.thumbhash


@pytest.mark.asyncio
async def test_a_heic_photo_and_a_broken_one(client, db, user):
    from app.files.media_pipeline import ingest
    from app.files.models import FileMedia

    buf = io.BytesIO()
    Image.new("RGB", (800, 600), "orange").save(buf, format="HEIF")
    fid = await _upload(client, user, "IMG_1.heic", buf.getvalue(), "image/heic")
    assert await ingest(fid) == "ready"
    media = await db.get(FileMedia, uuid.UUID(fid), populate_existing=True)
    assert (media.renditions["preview.webp"]["width"], media.renditions["preview.webp"]["height"]) == (800, 600)

    # A PNG signature with garbage after it: accepted at upload, can't decode.
    fid2 = await _upload(client, user, "broken.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 400, "image/png")
    assert await ingest(fid2) == "failed"
    media = await db.get(FileMedia, uuid.UUID(fid2), populate_existing=True)
    assert media.derivative_state == "failed" and media.error and media.attempts == 1


# ---------------------------------------------------------------- videos


@pytest.mark.asyncio
async def test_an_h264_video_is_copied_and_gets_a_poster(client, db, user, tmp_path):
    from app.files.derivatives import rendition_path
    from app.files.media_pipeline import ingest
    from app.files.models import FileMedia

    data = _video(tmp_path, "clip.mp4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac")
    fid = await _upload(client, user, "clip.mp4", data, "video/mp4")
    assert await ingest(fid) == "ready"
    media = await db.get(FileMedia, uuid.UUID(fid), populate_existing=True)
    assert media.renditions["video.mp4"]["transcoded"] is False
    assert {"poster.webp", "thumb.webp", "video.mp4"} <= set(media.renditions)
    out = rendition_path(fid, "video.mp4").read_bytes()
    assert out.index(b"moov") < out.index(b"mdat")  # +faststart: seeks before it's downloaded
    t = await client.get(f"/api/files/{fid}/thumbnail", headers=_auth(user))
    assert t.status_code == 200 and t.headers["content-type"] == "image/webp"


@pytest.mark.asyncio
async def test_an_hevc_iphone_style_video_is_transcoded_to_h264(client, db, user, tmp_path):
    from app.files.derivatives import rendition_path
    from app.files.media_pipeline import ingest
    from app.files.models import FileMedia

    data = _video(tmp_path, "IMG_0002.mov", "-c:v", "libx265", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-c:a", "aac")
    fid = await _upload(client, user, "IMG_0002.MOV", data, "video/quicktime")
    assert await ingest(fid) == "ready"
    media = await db.get(FileMedia, uuid.UUID(fid), populate_existing=True)
    assert media.renditions["video.mp4"]["transcoded"] is True and media.codec == "hevc"
    streams = _probe(rendition_path(fid, "video.mp4"))["streams"]
    video = next(s for s in streams if s["codec_type"] == "video")
    assert video["codec_name"] == "h264" and video["pix_fmt"] == "yuv420p"
    assert any(s["codec_type"] == "audio" and s["codec_name"] == "aac" for s in streams)


def test_the_hardware_encoder_falls_back_to_the_cpu(tmp_path, monkeypatch, root):
    from app.files import derivatives

    src = tmp_path / "in.mp4"
    src.write_bytes(_video(tmp_path, "in.mp4", "-c:v", "mpeg4", "-c:a", "aac"))
    monkeypatch.setenv("MEDIA_HWACCEL", "nvenc")  # no GPU here
    out = derivatives.render_video(src, uuid.uuid4(), derivatives.probe(src))
    assert out["transcoded"] is True and out["encoder"] == "libx264"


# ---------------------------------------------------------------- the pipeline


@pytest.mark.asyncio
async def test_the_sweep_puts_back_stuck_and_failed_work_and_finds_new_files(client, db, user, queued):
    from app.files.media_pipeline import MAX_ATTEMPTS, sweep
    from app.files.models import FileMedia

    stuck = await _upload(client, user, "a.jpg", _jpeg((60, 40)), "image/jpeg")
    failed = await _upload(client, user, "b.jpg", _jpeg((60, 40)), "image/jpeg")
    given_up = await _upload(client, user, "c.jpg", _jpeg((60, 40)), "image/jpeg")
    fresh = await _upload(client, user, "d.jpg", _jpeg((60, 40)), "image/jpeg")
    long_ago = datetime.now(timezone.utc) - timedelta(hours=2)
    db.add_all([
        FileMedia(file_id=uuid.UUID(stuck), kind="image", derivative_state="processing", processing_started_at=long_ago),
        FileMedia(file_id=uuid.UUID(failed), kind="image", derivative_state="failed", attempts=1),
        FileMedia(file_id=uuid.UUID(given_up), kind="image", derivative_state="failed", attempts=MAX_ATTEMPTS),
    ])
    await db.commit()
    queued.clear()
    out = await sweep()
    assert out["stuck"] == 1
    assert set(map(str, queued)) == {stuck, failed, fresh}
    assert (await db.get(FileMedia, uuid.UUID(stuck), populate_existing=True)).derivative_state == "pending"


@pytest.mark.asyncio
async def test_media_is_queued_on_the_media_queue_and_never_run_in_the_api(monkeypatch):
    from app.tasks import queue

    calls = []

    class Pool:
        async def enqueue_job(self, name, *args, **kw):
            calls.append((name, kw))

    async def pool():
        return Pool()

    monkeypatch.setattr(queue, "_get_pool", pool)
    fid = uuid.uuid4()
    await queue.enqueue_media(fid)
    assert calls == [(queue.MEDIA_INGEST, {"_queue_name": "promptly:media", "_job_id": f"media-{fid}"})]

    async def down():
        raise ConnectionError("redis down")

    monkeypatch.setattr(queue, "_get_pool", down)
    await queue.enqueue_media(fid)  # no error, nothing run here — the sweep has it


@pytest.mark.asyncio
async def test_a_purged_photo_takes_its_renditions_with_it(client, db, user):
    from app.files.derivatives import derived_dir
    from app.files.media_pipeline import ingest

    fid = await _upload(client, user, "gone.jpg", _jpeg((200, 100)), "image/jpeg")
    await ingest(fid)
    assert derived_dir(fid).is_dir()
    await client.post(f"/api/files/{fid}/trash", headers=_auth(user))
    r = await client.post("/api/files/bulk/purge", json={"file_ids": [fid], "folder_ids": []}, headers=_auth(user))
    assert r.status_code == 200, r.text
    assert not derived_dir(fid).exists()


def test_the_media_worker_listens_on_its_own_queue():
    from app.tasks.media_worker import MediaWorkerSettings
    from app.tasks.worker import WorkerSettings

    assert MediaWorkerSettings.queue_name == "promptly:media" and MediaWorkerSettings.max_jobs == 3  # two for media, one for understanding (PH-2)
    assert {f.name for f in MediaWorkerSettings.functions} == {"ingest_media_job"}
    assert "ingest_media_job" not in {f.name for f in WorkerSettings.functions}
