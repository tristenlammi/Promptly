"""Photo and video renditions (WP-7.4, Part C §4.5).

Made by the media worker, kept under ``derived/<file_id>/`` (regenerable,
never counted against anyone's storage, left out of backups):

* ``thumb.webp`` — the 320 px grid tile;
* ``preview.webp`` — 1440 px, what the viewer shows;
* ``poster.webp`` — a video's frame (then thumbnailed like a photo);
* ``video.mp4`` — a video anyone's browser plays: the original stream copied
  when it's already H.264 / yuv420p ("required" policy, like Immich),
  otherwise H.264/AAC at most 1080p, CRF 23; always ``+faststart`` so it
  seeks before it has downloaded;
* a ThumbHash in the row.

Speed: a JPEG decodes at reduced size (``draft``), a HEIC's embedded
thumbnail is used when it's big enough, and a camera raw's embedded preview
is read without decoding the raw (rawpy). Video work runs under ``nice``,
and the ``MEDIA_HWACCEL`` env (nvenc / vaapi / qsv — the GPU compose
overrides) moves the encode to a GPU, falling back to libx264.
"""
from __future__ import annotations

import io
import json
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any

from app.files import storage

logger = logging.getLogger("promptly.files.derivatives")

THUMB = 320
PREVIEW = 1440
VIDEO_MAX = 1920  # longest edge of a transcode (1080p)
_VIDEO_TIMEOUT = 2 * 3600

# The last two: an edited photo's, made from its edit record (PH-7).
RENDITION_NAMES = (
    "thumb.webp", "preview.webp", "poster.webp", "video.mp4", "thumb.edit.webp", "preview.edit.webp",
    # An Office file's faithful PDF and what it was made from (Stage 12).
    "office.pdf", "office.json",
)


def derived_dir(file_id: uuid.UUID | str) -> Path:
    return storage.UPLOAD_ROOT / "derived" / str(file_id)


def rendition_path(file_id: uuid.UUID | str, name: str) -> Path:
    if name not in RENDITION_NAMES:
        raise ValueError(name)
    return derived_dir(file_id) / name


def remove_derived(file_id: uuid.UUID | str) -> None:
    shutil.rmtree(derived_dir(file_id), ignore_errors=True)


# ------------------------------------------------------------------ images


def open_source(path: Path, kind: str):  # noqa: ANN201 — PIL.Image
    """The picture to make renditions from, upright and at most ~2× the
    preview size where the format lets us decode smaller."""
    from PIL import Image, ImageOps

    import app.files.imaging  # noqa: F401 — HEIC

    if kind == "raw":
        import rawpy

        with rawpy.imread(str(path)) as raw:
            thumb = raw.extract_thumb()
        if thumb.format == rawpy.ThumbFormat.JPEG:
            im = Image.open(io.BytesIO(thumb.data))
            im.draft("RGB", (PREVIEW * 2, PREVIEW * 2))
            im.load()
        else:
            im = Image.fromarray(thumb.data)
        return ImageOps.exif_transpose(im)

    im = Image.open(path)
    if getattr(im, "n_frames", 1) > 1:
        im.seek(0)  # a GIF / HEIC burst: its first frame
    if im.format == "JPEG":
        im.draft("RGB", (PREVIEW * 2, PREVIEW * 2))
    im.load()
    return ImageOps.exif_transpose(im)


def _save_webp(im, dest: Path, quality: int) -> dict[str, int]:  # noqa: ANN001
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".tmp")
    im.save(tmp, format="WEBP", quality=quality, method=4)
    os.replace(tmp, dest)
    return {"width": im.width, "height": im.height, "bytes": dest.stat().st_size}


def render_image(im, file_id: uuid.UUID | str, *, poster: bool = False) -> tuple[dict[str, Any], str]:  # noqa: ANN001
    """thumb + preview (or poster) WebPs and the ThumbHash."""
    from PIL import Image

    from app.files.thumbhash import image_to_thumbhash

    mode = "RGBA" if im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info else "RGB"
    im = im.convert(mode)
    big = im.copy()
    big.thumbnail((PREVIEW, PREVIEW), Image.LANCZOS, reducing_gap=3.0)
    out: dict[str, Any] = {}
    out["poster.webp" if poster else "preview.webp"] = _save_webp(big, rendition_path(file_id, "poster.webp" if poster else "preview.webp"), 82)
    small = big.copy()
    small.thumbnail((THUMB, THUMB), Image.LANCZOS)
    out["thumb.webp"] = _save_webp(small, rendition_path(file_id, "thumb.webp"), 76)
    return out, image_to_thumbhash(small)


# ------------------------------------------------------------------ video


def _run(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
    nice = ["nice", "-n", "10"] if shutil.which("nice") else []
    return subprocess.run(nice + cmd, capture_output=True, text=True, timeout=timeout, check=False)


def _video_stream(probe: dict[str, Any]) -> dict[str, Any] | None:
    return next((s for s in probe.get("streams", []) if s.get("codec_type") == "video"), None)


def poster_frame(path: Path, probe: dict[str, Any]):  # noqa: ANN201 — PIL.Image
    """A frame a second in (or a tenth of the way, for short clips)."""
    from PIL import Image

    try:
        duration = float((probe.get("format") or {}).get("duration") or 0)
    except ValueError:
        duration = 0
    at = min(1.0, duration / 10) if duration else 0
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "frame.png"
        r = _run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{at:.2f}", "-i", str(path), "-frames:v", "1", str(out)], 300)
        if r.returncode != 0 or not out.exists():
            raise RuntimeError(f"couldn't read a frame: {r.stderr.strip()[:300]}")
        im = Image.open(out)
        im.load()
        return im


def needs_transcode(probe: dict[str, Any]) -> bool:
    v = _video_stream(probe)
    if v is None:
        return True
    if (v.get("codec_name") or "") != "h264" or (v.get("pix_fmt") or "") != "yuv420p":
        return True
    w, h = int(v.get("width") or 0), int(v.get("height") or 0)
    return max(w, h) > 4096  # copying a huge stream helps no browser


def _scale_filter() -> str:
    # Fit the longest edge in VIDEO_MAX, never upscale, keep even sizes.
    m = VIDEO_MAX
    return (
        f"scale='if(gte(iw,ih),min({m},iw),-2)':'if(gte(iw,ih),-2,min({m},ih))'"
    )


def _encoder_args(hw: str | None) -> tuple[list[str], list[str], str]:
    """(input args, encoder args, -vf chain) for ``MEDIA_HWACCEL``."""
    scale = _scale_filter()
    if hw == "nvenc":
        return [], ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23", "-pix_fmt", "yuv420p"], f"{scale},format=yuv420p"
    if hw == "vaapi":
        device = os.environ.get("MEDIA_VAAPI_DEVICE", "/dev/dri/renderD128")
        return ["-vaapi_device", device], ["-c:v", "h264_vaapi", "-qp", "23"], f"{scale},format=nv12,hwupload"
    if hw == "qsv":
        return [], ["-c:v", "h264_qsv", "-global_quality", "23", "-pix_fmt", "nv12"], f"{scale},format=nv12"
    return [], ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"], f"{scale},format=yuv420p"


def render_video(path: Path, file_id: uuid.UUID | str, probe: dict[str, Any]) -> dict[str, Any]:
    """video.mp4 — copied or transcoded. Returns its rendition entry."""
    dest = rendition_path(file_id, "video.mp4")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name("video.tmp.mp4")
    audio = next((s for s in probe.get("streams", []) if s.get("codec_type") == "audio"), None)
    audio_args = ["-an"] if audio is None else (
        ["-c:a", "copy"] if (audio.get("codec_name") == "aac") else ["-c:a", "aac", "-b:a", "160k"]
    )
    common_out = ["-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-movflags", "+faststart"]
    transcoded = needs_transcode(probe)
    attempts: list[str | None] = []
    if transcoded:
        hw = (os.environ.get("MEDIA_HWACCEL") or "").strip().lower() or None
        attempts = [hw, None] if hw else [None]
    else:
        attempts = ["copy"]
    last = ""
    for mode in attempts:
        if mode == "copy":
            cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), *common_out, "-c:v", "copy", *audio_args, str(tmp)]
        else:
            pre, enc, vf = _encoder_args(mode)
            cmd = ["ffmpeg", "-y", "-loglevel", "error", *pre, "-i", str(path), *common_out, "-vf", vf, *enc, *audio_args, str(tmp)]
        r = _run(cmd, _VIDEO_TIMEOUT)
        if r.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
            os.replace(tmp, dest)
            return {"bytes": dest.stat().st_size, "transcoded": transcoded, "encoder": mode or "libx264"}
        last = r.stderr.strip()[-500:]
        tmp.unlink(missing_ok=True)
        if mode not in (None, "copy"):
            logger.warning("%s encode failed for %s, falling back to libx264: %s", mode, file_id, last)
    raise RuntimeError(f"video conversion failed: {last}")


def probe(path: Path) -> dict[str, Any]:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True, timeout=120, check=False,
    )
    try:
        return json.loads(r.stdout or "{}")
    except ValueError:
        return {}


# The brands an MP4/QuickTime clip's ``ftyp`` box opens with — what a motion
# photo's appended clip looks like (not HEIC's own ``heic``/``mif1``).
_CLIP_BRANDS = (b"mp41", b"mp42", b"isom", b"iso2", b"iso4", b"iso5", b"iso6", b"avc1", b"qt  ", b"M4V ")


def motion_clip_offset(data: bytes) -> int | None:
    """Where the clip inside a motion photo starts (Google's and Samsung's
    both append an MP4 after the picture), or None."""
    i = data.find(b"ftyp", 8)
    while i != -1:
        size = int.from_bytes(data[i - 4:i], "big")
        if 8 <= size <= 256 and data[i + 4:i + 8] in _CLIP_BRANDS:
            return i - 4
        i = data.find(b"ftyp", i + 4)
    return None


def render_motion_clip(path: Path, file_id: uuid.UUID | str) -> dict[str, Any] | None:
    """A motion photo's moment of video (WP-9.3), as its ``video.mp4``."""
    data = path.read_bytes()
    start = motion_clip_offset(data)
    if start is None:
        return None
    clip = derived_dir(file_id) / "motion.src.mp4"
    clip.parent.mkdir(parents=True, exist_ok=True)
    clip.write_bytes(data[start:])
    try:
        info = probe(clip)
        if _video_stream(info) is None:
            return None
        entry = render_video(clip, file_id, info)
        entry["motion"] = True
        return entry
    finally:
        clip.unlink(missing_ok=True)


def make_renditions(
    path: Path, file_id: uuid.UUID | str, kind: str, *, motion: bool = False
) -> tuple[dict[str, Any], str | None]:
    """Everything for one file (sync, CPU-heavy). Returns (renditions,
    thumbhash)."""
    if kind == "video":
        info = probe(path)
        frame = poster_frame(path, info)
        out, th = render_image(frame, file_id, poster=True)
        out["video.mp4"] = render_video(path, file_id, info)
        return out, th
    im = open_source(path, kind)
    out, th = render_image(im, file_id)
    if motion:
        try:
            clip = render_motion_clip(path, file_id)
        except Exception:  # noqa: BLE001 — the still is what matters; the clip is a bonus
            logger.warning("motion clip for %s failed", file_id, exc_info=True)
            clip = None
        if clip is not None:
            out["video.mp4"] = clip
    return out, th


__all__ = [
    "PREVIEW",
    "RENDITION_NAMES",
    "THUMB",
    "derived_dir",
    "make_renditions",
    "needs_transcode",
    "remove_derived",
    "rendition_path",
]
