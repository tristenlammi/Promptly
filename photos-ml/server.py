"""Promptly photos-ml — understanding photos on your own box (Part E §E4.2).

A small FastAPI service around ONNX Runtime, on the internal network only.
The backend's media worker sends it previews; the API sends it search
text. Nothing leaves the box except, once, the model download.

Models are pinned — repository, revision, and each file's SHA-256 — and
downloaded on first start into ``/models`` (``./data/models``), checked,
then loaded. ``GET /health`` says how far that's got.

Now: **SigLIP 2** (google/siglip2-base-patch16-224, Apache-2.0; the ONNX
export from onnx-community at a fixed revision) — one 768-d space for
images and text, so "dog on a beach" finds dogs on beaches. Images are
squashed to 224×224, scaled to −1…1 (the model's processor config); text is
lowercased and padded/truncated to 64 tokens, as it was trained.

Hardware: ``PHOTOS_ML_PROVIDERS`` (e.g. ``OpenVINOExecutionProvider`` or
``CUDAExecutionProvider``), falling back to the CPU; ``PHOTOS_ML_THREADS``.
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("photos-ml")
logging.getLogger("httpx").setLevel(logging.WARNING)  # its lines carry signed CDN URLs

MODEL_DIR = Path(os.environ.get("PHOTOS_ML_MODEL_DIR", "/models"))
HF = os.environ.get("PHOTOS_ML_HF_ENDPOINT", "https://huggingface.co").rstrip("/")
# fp32 text by default: the int8 export moved some phrases' vectors to a
# cosine of 0.64 from the original (scores shifted by up to 0.06, the whole
# gap between a match and not) — int8 only for a box short of ~1 GB of RAM.
TEXT_VARIANT = os.environ.get("PHOTOS_ML_TEXT_VARIANT", "fp32")  # fp32 | int8
VISION_VARIANT = os.environ.get("PHOTOS_ML_VISION_VARIANT", "fp32")  # fp32 | int8

SIGLIP = {
    "repo": "onnx-community/siglip2-base-patch16-224-ONNX",
    "revision": "ba1f3b0843f24bc5417d38e19c37b287d719b2f4",
    "files": {
        "vision:fp32": ("onnx/vision_model.onnx", 371807752, "c0573e3f4140c3a7c4e9cc5912bd6b26a033b46a6a8e8af26cbea262b163bcad"),
        "vision:int8": ("onnx/vision_model_int8.onnx", 94553333, "0dd31785a2713f1113ef2272472165c69d580473dae38d7b47568ac587795e70"),
        "text:fp32": ("onnx/text_model.onnx", 1129469657, "baf12d941beabafafb14f7b4adb38dc15be18681b964a84410ec53d9d65e6293"),
        "text:int8": ("onnx/text_model_int8.onnx", 283438275, "3a0603d3a00c05a80a6ded4743c16aaac7b1e62cdcc7e362e7ce418659b96400"),
        "tokenizer": ("tokenizer.json", 34363039, "cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322"),
    },
    "size": 224,
    "max_tokens": 64,
    "dim": 768,
}
MODEL_ID = f"siglip2-base-p16-224@{SIGLIP['revision'][:7]}:v-{VISION_VARIANT}:t-{TEXT_VARIANT}"

# Faces (WP-PH2.3) — loaded on the first face request (faces are opt-in per
# library, so nobody else pays their ~300 MB of RAM).
#   YuNet (OpenCV Zoo, MIT): detection + 5 landmarks, via cv2.FaceDetectorYN.
#   AuraFace v1 (fal, Apache-2.0): ResNet100 ArcFace-style, 512-d. Its file
#   is glintr100.onnx — NOT InsightFace's glintr100 (non-commercial; that one
#   is 260,665,334 bytes, sha256 4ab1d643…): checked 2026-10-14. The other
#   files in fal's repo (scrfd, 2d106det, 1k3d68, genderage) are InsightFace's
#   own and are never downloaded.
YUNET = {
    "repo": "opencv/face_detection_yunet", "revision": "3cc26e7f1014a5ee5d74a42acee58bafc9d0a310", "dir": "yunet",
    "file": ("face_detection_yunet_2023mar.onnx", 232589, "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
}
AURAFACE = {
    "repo": "fal/AuraFace-v1", "revision": "af6d057c9b0ec4071d4c49c80e3539258798b609", "dir": "auraface-v1",
    "file": ("glintr100.onnx", 260694151, "a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60"),
}
FACE_MODEL_ID = f"yunet-2023mar+auraface-v1@{AURAFACE['revision'][:7]}"
# The ArcFace 112×112 template (InsightFace's arcface_dst): the eye on the
# image's left, the other eye, nose tip, mouth corners left and right.
_ARC_DST = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]]
FACE_MIN_SCORE = float(os.environ.get("PHOTOS_ML_FACE_MIN_SCORE", "0.7"))
FACE_MIN_PX = 20

# Animals (WP-PH2.4) — also loaded on first use.
#   D-FINE small, COCO (Peterande/ustc-community, Apache-2.0): detection.
#   Each animal's crop gets two vectors for PH-3 to match against the
#   household's named pets: SigLIP 2's (already loaded) and DINOv2 small's
#   mean patch token (Meta, Apache-2.0). On 35 public-domain photos of two
#   black Portuguese water dogs (Bo and Sunny) neither won clearly (3 named
#   photos each → 68–71% right); PH-3 decides on the owner's own pets. The
#   roadmap's first choice, AvitoTech's DINOv2 pet-ID fine-tune, is trained
#   on PetFace — "non-commercial research purpose only" — so it isn't used.
#   The species comes from SigLIP on the crop, not the detector: D-FINE
#   called a fluffy cat a bear and every curly black dog a teddy bear.
DFINE = {
    "repo": "onnx-community/dfine_s_coco-ONNX", "revision": "a3cf03147a9b86c78475139115c8ac142577352d", "dir": "dfine-s-coco",
    "file": ("onnx/model.onnx", 41535197, "cd8a49a945feda6d28c6304ae8ae85c2759ba1d78a5a83a22c5ce8db82ef7238"),
}
DINOV2 = {
    "repo": "onnx-community/dinov2-small-ONNX", "revision": "08c606e3123472a388efa59181b677d428f69bbd", "dir": "dinov2-small",
    "file": ("onnx/model.onnx", 88513997, "6266c3cd72db6953cecdcbfeab9422a9f783d96f1a4e296ba70ffbac43b54a18"),
}
ANIMAL_MODEL_ID = f"dfine-s-coco@{DFINE['revision'][:7]}+dinov2-s@{DINOV2['revision'][:7]}"
# COCO ids (the model's id2label) that may be an animal: bird … giraffe,
# and teddy bear (what it calls a curly dog).
_ANIMAL_CLASSES = set(range(14, 24)) | {77}
ANIMAL_MIN_SCORE = float(os.environ.get("PHOTOS_ML_ANIMAL_MIN_SCORE", "0.4"))
# What SigLIP chooses between on the crop; the last two aren't animals.
SPECIES = ["dog", "cat", "bird", "horse", "rabbit", "guinea pig", "hamster", "sheep", "cow", "goat", "pig",
           "chicken", "duck", "lizard", "turtle", "fish", "bear", "stuffed toy", "person"]
_NOT_ANIMALS = {"stuffed toy", "person"}
_species_vectors = None
_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Text in photos (WP-PH2.5) — RapidOCR 3.9.2 (Apache-2.0) running
# PaddleOCR's PP-OCRv6 small det/rec + PP-OCRv4 orientation models
# (Apache-2.0): Chinese, English and Japanese. RapidOCR pins each model by
# SHA-256 (its default_models.yaml) and downloads it once into /models.
OCR_MODEL_ID = "rapidocr-3.9.2:pp-ocrv6-small-ch"
OCR_MIN_SCORE = float(os.environ.get("PHOTOS_ML_OCR_MIN_SCORE", "0.6"))
ocr_state: dict[str, Any] = {"state": "idle", "error": None}
_ocr = None
_ocr_lock = threading.Lock()

animals_state: dict[str, Any] = {"state": "idle", "error": None}
_detr = _dino = None
_animal_lock = threading.Lock()

faces_state: dict[str, Any] = {"state": "idle", "error": None}
_detector = _recogniser = None
_face_lock = threading.Lock()

state: dict[str, Any] = {"state": "starting", "error": None, "bytes_done": 0, "bytes_total": 0}
_vision = _text = _tokenizer = None
_lock = threading.Lock()



# ------------------------------------------------------------------ download


def _wanted() -> list[tuple[str, int, str]]:
    f = SIGLIP["files"]
    return [f[f"vision:{VISION_VARIANT}"], f[f"text:{TEXT_VARIANT}"], f["tokenizer"]]


def _local(path: str, dirname: str = "siglip2-base-patch16-224", revision: str = SIGLIP["revision"]) -> Path:
    return MODEL_DIR / dirname / revision[:12] / path


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(4 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _download(path: str, size: int, sha: str, model: dict | None = None) -> Path:
    import httpx

    model = model or {"repo": SIGLIP["repo"], "revision": SIGLIP["revision"], "dir": "siglip2-base-patch16-224"}
    dest = _local(path, model["dir"], model["revision"])
    if dest.is_file() and dest.stat().st_size == size:
        return dest  # checked when it was downloaded
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    url = f"{HF}/{model['repo']}/resolve/{model['revision']}/{path}"
    log.info("downloading %s (%d MB)", url, size >> 20)
    h = hashlib.sha256()
    with httpx.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(60.0, connect=20.0)) as r:
        r.raise_for_status()
        with open(part, "wb") as out:
            for chunk in r.iter_bytes(1 << 20):
                out.write(chunk)
                h.update(chunk)
                state["bytes_done"] += len(chunk)
    if h.hexdigest() != sha:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"{path} didn't match its checksum")
    os.replace(part, dest)
    return dest


def _threads() -> int:
    """One thread per CPU this container may use. ONNX Runtime's default is
    every core on the host: inside a 2-CPU limit on a 32-core box that was
    12× slower (16 images: 20.5 s against 1.7 s)."""
    n = int(os.environ.get("PHOTOS_ML_THREADS", "0") or 0)
    if n > 0:
        return n
    try:
        quota, period = open("/sys/fs/cgroup/cpu.max").read().split()[:2]
        if quota != "max":
            return max(1, -(-int(quota) // int(period)))
    except (OSError, ValueError):
        pass
    return max(1, len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else (os.cpu_count() or 1))


def _session(path: Path):  # noqa: ANN202
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = _threads()
    opts.inter_op_num_threads = 1
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    # The CPU arena keeps the biggest batch's buffers for good: with every
    # model loaded that grew past 3.4 GB and got the container OOM-killed
    # (then restarted, reloading everything, in a loop). Off, it settles
    # at ~2.7 GB for the same work.
    opts.enable_cpu_mem_arena = False
    wanted = [p.strip() for p in os.environ.get("PHOTOS_ML_PROVIDERS", "").split(",") if p.strip()]
    available = ort.get_available_providers()
    providers = [p for p in wanted if p in available] + ["CPUExecutionProvider"]
    return ort.InferenceSession(str(path), sess_options=opts, providers=providers)


def _prepare() -> None:
    global _vision, _text, _tokenizer
    try:
        files = _wanted()
        state["bytes_total"] = sum(s for p, s, _ in files if not (_local(p).is_file() and _local(p).stat().st_size == s))
        state["state"] = "downloading" if state["bytes_total"] else "loading"
        for path, size, sha in files:
            _download(path, size, sha)
        state["state"] = "loading"
        from tokenizers import Tokenizer

        vision_path, text_path, tok_path = (_local(p) for p, _, _ in files)
        _tokenizer = Tokenizer.from_file(str(tok_path))
        _vision = _session(vision_path)
        _text = _session(text_path)
        log.info("ready: %s on %s", MODEL_ID, _vision.get_providers())
        state["state"] = "ready"
    except Exception as exc:  # noqa: BLE001 — reported on /health, retried below
        log.exception("couldn't prepare the models")
        state.update(state="error", error=f"{exc.__class__.__name__}: {exc}"[:300])


def _keep_trying() -> None:
    delay = 30
    while True:
        _prepare()
        if state["state"] == "ready":
            return
        time.sleep(delay)
        delay = min(delay * 2, 3600)


@asynccontextmanager
async def _lifespan(_app):  # noqa: ANN001, ANN202
    threading.Thread(target=_keep_trying, daemon=True).start()
    yield


app = FastAPI(title="Promptly photos-ml", lifespan=_lifespan)


# ------------------------------------------------------------------ inference


def _output(session, names: tuple[str, ...]) -> str:  # noqa: ANN001
    outs = [o.name for o in session.get_outputs()]
    return next((n for n in names if n in outs), outs[-1])


def _normalise(v: np.ndarray) -> np.ndarray:
    return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)


def _pixels(raw: bytes) -> np.ndarray:
    from PIL import Image

    size = SIGLIP["size"]
    with Image.open(io.BytesIO(raw)) as im:
        im = im.convert("RGB").resize((size, size), Image.Resampling.BILINEAR)
        a = np.asarray(im, dtype=np.float32) / 255.0
    return ((a - 0.5) / 0.5).transpose(2, 0, 1)


def embed_images(raws: list[bytes]) -> list[list[float] | None]:
    out: list[list[float] | None] = [None] * len(raws)
    batch, where = [], []
    for i, raw in enumerate(raws):
        try:
            batch.append(_pixels(raw))
            where.append(i)
        except Exception:  # noqa: BLE001 — one unreadable picture is a None
            continue
    if batch:
        name = _output(_vision, ("image_embeds", "pooler_output"))
        vec = _vision.run([name], {_vision.get_inputs()[0].name: np.stack(batch)})[0]
        for i, v in zip(where, _normalise(vec.reshape(len(batch), -1))):
            out[i] = [round(float(x), 6) for x in v]
    return out


def embed_texts(texts: list[str]) -> list[list[float]]:
    n = SIGLIP["max_tokens"]
    ids = np.zeros((len(texts), n), dtype=np.int64)  # <pad> is 0
    mask = np.zeros((len(texts), n), dtype=np.int64)
    for row, text in enumerate(texts):
        tokens = _tokenizer.encode(text.lower(), add_special_tokens=True).ids
        if not tokens or tokens[-1] != 1:
            tokens = tokens + [1]  # <eos>: the tokenizer was trained to end with it
        tokens = tokens[: n - 1] + [1] if len(tokens) > n else tokens
        ids[row, : len(tokens)] = tokens
        mask[row, : len(tokens)] = 1
    feeds = {}
    for inp in _text.get_inputs():
        feeds[inp.name] = ids if inp.name == "input_ids" else mask
    name = _output(_text, ("text_embeds", "pooler_output"))
    vec = _text.run([name], feeds)[0]
    return [[round(float(x), 6) for x in v] for v in _normalise(vec.reshape(len(texts), -1))]


# ------------------------------------------------------------------ faces


def _prepare_faces() -> None:
    global _detector, _recogniser
    try:
        faces_state.update(state="downloading", error=None)
        det = _download(*YUNET["file"], model=YUNET)
        rec = _download(*AURAFACE["file"], model=AURAFACE)
        faces_state["state"] = "loading"
        import cv2

        _detector = cv2.FaceDetectorYN.create(str(det), "", (320, 320), FACE_MIN_SCORE, 0.3, 5000)
        _recogniser = _session(rec)
        faces_state["state"] = "ready"
        log.info("faces ready: %s", FACE_MODEL_ID)
    except Exception as exc:  # noqa: BLE001 — reported, retried on the next request
        log.exception("couldn't prepare the face models")
        faces_state.update(state="error", error=f"{exc.__class__.__name__}: {exc}"[:300])


def _prepare_animals() -> None:
    global _detr, _dino
    try:
        animals_state.update(state="downloading", error=None)
        det = _download(*DFINE["file"], model=DFINE)
        emb = _download(*DINOV2["file"], model=DINOV2)
        animals_state["state"] = "loading"
        _detr = _session(det)
        _dino = _session(emb)
        animals_state["state"] = "ready"
        log.info("animals ready: %s", ANIMAL_MODEL_ID)
    except Exception as exc:  # noqa: BLE001
        log.exception("couldn't prepare the animal models")
        animals_state.update(state="error", error=f"{exc.__class__.__name__}: {exc}"[:300])


def _animals_ready() -> None:
    _ready()
    if animals_state["state"] in ("idle", "error"):
        animals_state["state"] = "starting"
        threading.Thread(target=_prepare_animals, daemon=True).start()
    if animals_state["state"] != "ready":
        raise HTTPException(503, f"Animal models aren't ready ({animals_state['state']}).")


def _dino_input(crop) -> np.ndarray:  # noqa: ANN001 — a PIL image
    """DINOv2's processor: shortest edge 256 (bicubic), centre 224, ImageNet
    mean/std."""
    from PIL import Image

    w, h = crop.size
    k = 256 / min(w, h)
    im = crop.resize((max(224, round(w * k)), max(224, round(h * k))), Image.Resampling.BICUBIC)
    left, top = (im.width - 224) // 2, (im.height - 224) // 2
    a = np.asarray(im.crop((left, top, left + 224, top + 224)), dtype=np.float32) / 255.0
    return ((a - _IMAGENET_MEAN) / _IMAGENET_STD).transpose(2, 0, 1)


def _siglip_of(images: list) -> np.ndarray:  # noqa: ANN001 — PIL images
    size = SIGLIP["size"]
    from PIL import Image

    batch = np.stack([
        ((np.asarray(im.convert("RGB").resize((size, size), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0 - 0.5) / 0.5
         ).transpose(2, 0, 1) for im in images
    ])
    name = _output(_vision, ("image_embeds", "pooler_output"))
    return _normalise(_vision.run([name], {_vision.get_inputs()[0].name: batch})[0].reshape(len(images), -1))


def find_animals(raw: bytes) -> list[dict[str, Any]]:
    """Every animal: what kind (SigLIP on the crop), where (0–1), how sure
    the detector is, and two vectors of it."""
    global _species_vectors
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as im:
        rgb = im.convert("RGB")
        rgb.load()
    w, h = rgb.size
    # D-FINE's processor: 640×640, scaled to 0–1, not normalised.
    x = (np.asarray(rgb.resize((640, 640), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0).transpose(2, 0, 1)[None]
    with _animal_lock:
        names = [o.name for o in _detr.get_outputs()]
        outs = dict(zip(names, _detr.run(None, {_detr.get_inputs()[0].name: x})))
    logits = outs.get("logits", list(outs.values())[0])[0]
    boxes = outs.get("pred_boxes", list(outs.values())[1])[0]
    probs = 1 / (1 + np.exp(-logits))
    found: list[dict[str, Any]] = []
    for q in np.argsort(-probs.max(axis=1)):
        cls = int(np.argmax(probs[q]))
        score = float(probs[q, cls])
        if score < ANIMAL_MIN_SCORE:
            break
        if cls not in _ANIMAL_CLASSES:
            continue
        cx, cy, bw, bh = (float(v) for v in boxes[q])
        box = [max(0.0, cx - bw / 2), max(0.0, cy - bh / 2), min(1.0, bw), min(1.0, bh)]
        # One animal seen twice (a dog and a "teddy bear"): the surer one.
        if any(_iou(f["box"], box) > 0.7 for f in found):
            continue
        found.append({"box": [round(v, 5) for v in box], "score": round(score, 4)})
    if not found:
        return []
    crops, pils = [], []
    for f in found:
        bx, by, bw, bh = f["box"]
        # A little room around it, as the pet-ID crops are framed.
        mx, my = bw * 0.1, bh * 0.1
        l, t = max(0, int((bx - mx) * w)), max(0, int((by - my) * h))
        r, b = min(w, int((bx + bw + mx) * w)), min(h, int((by + bh + my) * h))
        f["size"] = int(min(r - l, b - t))
        crop = rgb.crop((l, t, max(r, l + 1), max(b, t + 1)))
        pils.append(crop)
        crops.append(_dino_input(crop))
    sig = _siglip_of(pils)
    if _species_vectors is None:
        _species_vectors = np.array(embed_texts([f"This is a photo of a {s}." for s in SPECIES]))
    kinds = [SPECIES[int(i)] for i in np.argmax(sig @ _species_vectors.T, axis=1)]
    out = _dino.run(None, {_dino.get_inputs()[0].name: np.stack(crops)})
    got = dict(zip([o.name for o in _dino.get_outputs()], out))
    dino = _normalise(got["last_hidden_state"][:, 1:, :].mean(axis=1))  # the mean patch token
    animals = []
    for f, kind, s, d in zip(found, kinds, sig, dino):
        if kind in _NOT_ANIMALS:
            continue
        f["species"] = kind
        f["embedding"] = [round(float(x), 6) for x in s]
        f["embedding_dino"] = [round(float(x), 6) for x in d]
        animals.append(f)
    return animals


def _iou(a: list[float], b: list[float]) -> float:
    ax2, ay2, bx2, by2 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw, ih = max(0.0, min(ax2, bx2) - max(a[0], b[0])), max(0.0, min(ay2, by2) - max(a[1], b[1]))
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def _prepare_ocr() -> None:
    global _ocr
    try:
        ocr_state.update(state="downloading", error=None)
        from rapidocr import RapidOCR

        root = MODEL_DIR / "rapidocr"
        root.mkdir(parents=True, exist_ok=True)
        _ocr = RapidOCR(params={
            "Global.model_root_dir": str(root),
            "Global.log_level": "warning",
            "EngineConfig.onnxruntime.intra_op_num_threads": _threads(),
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        })
        ocr_state["state"] = "ready"
        log.info("text ready: %s", OCR_MODEL_ID)
    except Exception as exc:  # noqa: BLE001
        log.exception("couldn't prepare the text models")
        ocr_state.update(state="error", error=f"{exc.__class__.__name__}: {exc}"[:300])


def _ocr_ready() -> None:
    _ready()
    if ocr_state["state"] in ("idle", "error"):
        ocr_state["state"] = "starting"
        threading.Thread(target=_prepare_ocr, daemon=True).start()
    if ocr_state["state"] != "ready":
        raise HTTPException(503, f"Text models aren't ready ({ocr_state['state']}).")


def find_text(raw: bytes) -> dict[str, Any]:
    """The words in a picture, top to bottom: each line with where it is
    (0–1) and how sure the reader is, and all of it as one text."""
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as im:
        rgb = np.asarray(im.convert("RGB"))
    h, w = rgb.shape[:2]
    with _ocr_lock:
        res = _ocr(rgb[:, :, ::-1].copy())  # it reads BGR, as OpenCV does
    lines = []
    for box, txt, score in zip(res.boxes if res.boxes is not None else [], res.txts or (), res.scores or ()):
        txt = (txt or "").strip()
        if not txt or float(score) < OCR_MIN_SCORE:
            continue
        xs, ys = [float(p[0]) for p in box], [float(p[1]) for p in box]
        lines.append({
            "text": txt, "score": round(float(score), 3),
            "box": [round(min(xs) / w, 4), round(min(ys) / h, 4), round((max(xs) - min(xs)) / w, 4), round((max(ys) - min(ys)) / h, 4)],
        })
    lines.sort(key=lambda ln: (round(ln["box"][1] * 20), ln["box"][0]))
    return {"text": "\n".join(ln["text"] for ln in lines), "lines": lines}


def _faces_ready() -> None:
    _ready()
    if faces_state["state"] in ("idle", "error"):
        faces_state["state"] = "starting"
        threading.Thread(target=_prepare_faces, daemon=True).start()
    if faces_state["state"] != "ready":
        raise HTTPException(503, f"Face models aren't ready ({faces_state['state']}).")


def find_faces(raw: bytes) -> list[dict[str, Any]]:
    """Every face in a picture: where (0–1 of the picture), its landmarks,
    how sure the detector is, its size in pixels, and its 512-d vector."""
    import cv2
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as im:
        rgb = np.asarray(im.convert("RGB"))
    bgr = np.ascontiguousarray(rgb[:, :, ::-1])
    h, w = bgr.shape[:2]
    with _face_lock:  # FaceDetectorYN keeps per-call state
        _detector.setInputSize((w, h))
        _, found = _detector.detect(bgr)
    if found is None:
        return []
    dst = np.array(_ARC_DST, dtype=np.float32)
    faces, crops = [], []
    for f in found:
        x, y, fw, fh = (float(v) for v in f[:4])
        score = float(f[14])
        if score < FACE_MIN_SCORE or min(fw, fh) < FACE_MIN_PX:
            continue
        marks = np.array(f[4:14], dtype=np.float32).reshape(5, 2)
        m, _ = cv2.estimateAffinePartial2D(marks, dst, method=cv2.LMEDS)
        if m is None:
            continue
        crops.append(cv2.warpAffine(rgb, m, (112, 112), borderValue=0.0))
        faces.append({
            "box": [round(x / w, 5), round(y / h, 5), round(fw / w, 5), round(fh / h, 5)],
            "landmarks": [[round(float(px) / w, 5), round(float(py) / h, 5)] for px, py in marks],
            "score": round(score, 4),
            "size": int(min(fw, fh)),
        })
    if crops:
        blob = ((np.stack(crops).astype(np.float32) - 127.5) / 127.5).transpose(0, 3, 1, 2)
        vec = _normalise(_recogniser.run(None, {_recogniser.get_inputs()[0].name: blob})[0].reshape(len(crops), -1))
        for face, v in zip(faces, vec):
            face["embedding"] = [round(float(x), 6) for x in v]
    return faces


def _ready() -> None:
    if state["state"] != "ready":
        raise HTTPException(503, f"Models aren't ready ({state['state']}).")


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        **state, "model": MODEL_ID, "dim": SIGLIP["dim"], "providers": _vision.get_providers() if _vision else [],
        "faces": {**faces_state, "model": FACE_MODEL_ID},
        "animals": {**animals_state, "model": ANIMAL_MODEL_ID},
        "text": {**ocr_state, "model": OCR_MODEL_ID},
    }


class Texts(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=64)


@app.post("/v1/embed/texts")
def texts(body: Texts) -> dict[str, Any]:
    _ready()
    return {"model": MODEL_ID, "vectors": embed_texts([t[:500] for t in body.texts])}


@app.post("/v1/text/prepare")
def text_prepare() -> dict[str, Any]:
    try:
        _ocr_ready()
    except HTTPException:
        pass
    return {**ocr_state, "model": OCR_MODEL_ID}


@app.post("/v1/text")
def text_in(files: list[UploadFile] = File(...)) -> dict[str, Any]:  # noqa: B008
    """The text in up to 16 pictures."""
    _ocr_ready()
    if len(files) > 16:
        raise HTTPException(413, "At most 16 images at a time.")
    out: list[dict[str, Any] | None] = []
    for f in files:
        try:
            out.append(find_text(f.file.read(20 << 20)))
        except Exception:  # noqa: BLE001
            log.warning("text: a picture couldn't be read", exc_info=True)
            out.append(None)
    return {"model": OCR_MODEL_ID, "texts": out}


@app.post("/v1/animals/prepare")
def animals_prepare() -> dict[str, Any]:
    try:
        _animals_ready()
    except HTTPException:
        pass
    return {**animals_state, "model": ANIMAL_MODEL_ID}


@app.post("/v1/animals")
def animals(files: list[UploadFile] = File(...)) -> dict[str, Any]:  # noqa: B008
    """Animals in up to 16 pictures."""
    _animals_ready()
    if len(files) > 16:
        raise HTTPException(413, "At most 16 images at a time.")
    out: list[list[dict[str, Any]] | None] = []
    for f in files:
        try:
            out.append(find_animals(f.file.read(20 << 20)))
        except Exception:  # noqa: BLE001
            log.warning("animals: a picture couldn't be read", exc_info=True)
            out.append(None)
    return {"model": ANIMAL_MODEL_ID, "animals": out}


@app.post("/v1/faces/prepare")
def faces_prepare() -> dict[str, Any]:
    """Start loading the face models (the first library that turns faces on)."""
    try:
        _faces_ready()
    except HTTPException:
        pass
    return {**faces_state, "model": FACE_MODEL_ID}


@app.post("/v1/faces")
def faces(files: list[UploadFile] = File(...)) -> dict[str, Any]:  # noqa: B008
    """Faces in up to 16 pictures (the first call loads the face models:
    503 until they're in)."""
    _faces_ready()
    if len(files) > 16:
        raise HTTPException(413, "At most 16 images at a time.")
    out: list[list[dict[str, Any]] | None] = []
    for f in files:
        try:
            out.append(find_faces(f.file.read(20 << 20)))
        except Exception:  # noqa: BLE001 — one unreadable picture is a None
            log.warning("faces: a picture couldn't be read", exc_info=True)
            out.append(None)
    return {"model": FACE_MODEL_ID, "faces": out}


@app.post("/v1/embed/images")
def images(files: list[UploadFile] = File(...)) -> dict[str, Any]:  # noqa: B008
    _ready()
    if len(files) > 32:
        raise HTTPException(413, "At most 32 images at a time.")
    raws = [f.file.read(20 << 20) for f in files]
    with _lock:  # one batch at a time: the cores are already busy with it
        return {"model": MODEL_ID, "vectors": embed_images(raws)}
