"""Talk bench (WP-T0): measure the speech pipeline before Talk is built on it.

One file, run in three images, because each number lives in a different one:

* the **backend** image (``python -m app.talk.bench clips|run``): makes the test
  clips with the ``tts`` service, times today's HTTP path to ``whisper`` and
  ``tts``, and times the voice model's first token through Promptly's own
  provider code (read-only: it reads the admin's model choice, never changes it);
* the **whisper** image (``python bench.py whisper|smart-turn``): Whisper
  ``base``/``small`` per pass in-process, the live lane's re-decode every
  400 ms (one speaker and two at once), and Smart Turn v3;
* the **tts** image (``python bench.py kokoro``): Kokoro ``create`` per clause
  and ``create_stream`` time to its first chunk.

Typical run (Git Bash, from the repo root; ``B`` = a scratch folder for clips and
results; nothing here touches the running ``whisper``/``tts`` containers beyond
ordinary requests to them):

    C=docker-compose.yml
    docker compose -f $C run --rm --no-deps -v "$B:/bench" --entrypoint python \\
        backend -m app.talk.bench clips --out /bench/clips
    docker compose -f $C run --rm --no-deps -v "$B:/bench" --entrypoint python \\
        backend -m app.talk.bench run --clips /bench/clips --json /bench/http.json
    docker run --rm -v "$B:/bench" -v promptly-talkbench:/root/.cache \\
        -v "$PWD/backend/app/talk/bench.py:/probe/bench.py:ro" promptly-whisper \\
        python /probe/bench.py whisper --clips /bench/clips --models base,small \\
        --json /bench/whisper.json
    docker run ... promptly-whisper python /probe/bench.py smart-turn \\
        --clips /bench/clips --json /bench/smart_turn.json
    docker run --rm -v "$B:/bench" -v "$PWD/data/tts:/root/.cache:ro" \\
        -v "$PWD/backend/app/talk/bench.py:/probe/bench.py:ro" promptly-tts \\
        python /probe/bench.py kokoro --json /bench/kokoro.json   # and --threads 4

``promptly-talkbench`` is a throwaway volume for the Whisper weights the probe
downloads (``small`` isn't cached on every box) and the Smart Turn model, which
is checked against its pinned SHA-256. The browser half of WP-T0 is
``echo_test.html`` next to this file. Results from the dev box are in
``docs/talking-plan.md`` under "WP-T0 measurements".

The clips are synthetic speech made for the bench, kept only in the scratch
folder you pass. Results are timings and word counts, never anyone's audio.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import os
import re
import statistics
import sys
import threading
import time
import urllib.request
import wave
from pathlib import Path
from typing import Any, Callable

SAMPLE_RATE = 16_000
# What the live lane would do while you talk: re-decode the audio so far this often.
LIVE_STEP_S = 0.4

# The bench's sentences: everyday Talk requests from about 1 to 6 seconds long,
# plus two cut off mid-thought for Smart Turn ("I want to go to… um…").
CLIPS: list[dict[str, Any]] = [
    {"id": "s1", "text": "Set a timer.", "complete": True},
    {"id": "s2", "text": "What's on my calendar today?", "complete": True},
    {"id": "s3", "text": "Add milk and eggs to my shopping list, please.", "complete": True},
    {"id": "s4", "text": "Remind me to call Mum at six o'clock this evening.", "complete": True},
    {"id": "s5", "text": "Can you add the dentist to my calendar on Thursday at nine in the morning?", "complete": True},
    {
        "id": "s6",
        "text": "I need directions to the nearest Bunnings, and let me know if there's any traffic on the way there.",
        "complete": True,
    },
    {
        "id": "s7",
        "text": "Text Sam that I'm running about fifteen minutes late, and ask him if we can push the meeting back to half past three this afternoon.",
        "complete": True,
    },
    {"id": "u1", "text": "I want to go to the", "complete": False},
    {"id": "u2", "text": "Can you remind me to call", "complete": False},
]

# Smart Turn v3.2 (Pipecat, BSD 2-clause), the int8 CPU build, pinned by hash.
SMART_TURN_URL = "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx"
SMART_TURN_SHA256 = "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f"

# What Talk would hand Kokoro first (a clause), a short reply, a full reply, and
# a paragraph long enough for create_stream to yield more than one chunk.
TTS_TEXTS = {
    "clause": "You've got three things today,",
    "short": "The dentist is at nine on Thursday.",
    "long": "You've got three things today: the dentist at nine, a call with Sam at two, and the bins go out tonight.",
    "paragraph": (
        "You've got three things today. The dentist is at nine, so leave by half past eight "
        "because the roadworks on the highway are still slowing things down. Sam's call is at two, "
        "and he wanted to go over the budget for the garden before the weekend, so have the quote "
        "from the landscaper handy. The bins go out tonight, and it's the recycling week as well "
        "as the general waste. Tomorrow looks quieter, with only the school pickup at three and "
        "a reminder to renew the car registration before Friday, which you can do online in a "
        "few minutes. Want me to set a reminder for the registration?"
    ),
}

# Two voice-style prompts, as in the voice roadmap's model measurements (§5.2).
MODEL_PROMPTS = ["What's the capital of Australia?", "What's the weather like today?"]


# ---------------------------------------------------------------- small helpers


def _ms(seconds: float) -> float:
    return round(seconds * 1000.0, 1)


def _stats(values: list[float]) -> dict[str, float]:
    if not values:
        return {}
    ordered = sorted(values)
    p90 = ordered[min(len(ordered) - 1, int(round(0.9 * (len(ordered) - 1))))]
    return {
        "n": len(values),
        "median": round(statistics.median(ordered), 1),
        "p90": round(p90, 1),
        "min": round(ordered[0], 1),
        "max": round(ordered[-1], 1),
    }


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower().replace("’", "'"))


def word_error_rate(reference: str, heard: str) -> float:
    ref, hyp = _words(reference), _words(heard)
    if not ref:
        return 0.0 if not hyp else 1.0
    row = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, row[0] = row[0], i
        for j, h in enumerate(hyp, 1):
            cur = min(row[j] + 1, row[j - 1] + 1, prev + (r != h))
            prev, row[j] = row[j], cur
    return round(row[-1] / len(ref), 3)


def _load() -> dict[str, float]:
    try:
        one, five, _ = os.getloadavg()
        return {"load1": round(one, 2), "load5": round(five, 2), "cpus": os.cpu_count() or 0}
    except OSError:
        return {"cpus": os.cpu_count() or 0}


def _rss_mb() -> float | None:
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return round(int(line.split()[1]) / 1024.0, 1)
    except OSError:
        return None
    return None


def _write_json(path: str | None, data: dict[str, Any]) -> None:
    text = json.dumps(data, indent=2)
    if path:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(text)
    print(text)


def _wav_bytes(samples, rate: int) -> bytes:
    import numpy as np

    pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _read_wav(path: Path):
    import numpy as np

    with wave.open(str(path), "rb") as w:
        rate = w.getframerate()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    if rate != SAMPLE_RATE:
        raise SystemExit(f"{path.name}: expected {SAMPLE_RATE} Hz, got {rate}")
    return data


def _load_clips(folder: str) -> list[dict[str, Any]]:
    manifest = json.loads((Path(folder) / "manifest.json").read_text())
    for clip in manifest["clips"]:
        clip["audio"] = _read_wav(Path(folder) / clip["file"])
    return manifest["clips"]


def _resample_to_16k(samples, rate: int):
    import numpy as np

    if rate == SAMPLE_RATE:
        return np.asarray(samples, dtype=np.float32)
    from math import gcd

    try:
        from scipy.signal import resample_poly

        g = gcd(SAMPLE_RATE, rate)
        return resample_poly(samples, SAMPLE_RATE // g, rate // g).astype(np.float32)
    except ImportError:  # linear is fine for timing clips
        n = int(round(len(samples) * SAMPLE_RATE / rate))
        x = np.linspace(0, len(samples) - 1, n)
        return np.interp(x, np.arange(len(samples)), samples).astype(np.float32)


# ------------------------------------------------- backend image: clips and run


async def _tts_http(client, base: str, text: str, voice: str | None = None) -> tuple[bytes, float]:
    t0 = time.perf_counter()
    resp = await client.post(f"{base}/tts", json={"text": text, "voice": voice} if voice else {"text": text})
    resp.raise_for_status()
    return resp.content, time.perf_counter() - t0


async def cmd_clips(args: argparse.Namespace) -> None:
    """Synthesise the bench sentences with Kokoro and save them as 16 kHz WAVs."""
    import httpx
    import numpy as np

    from app.config import get_settings

    settings = get_settings()
    base = (args.tts_url or settings.TTS_URL).rstrip("/")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    async with httpx.AsyncClient(timeout=60) as client:
        for clip in CLIPS:
            wav, _ = await _tts_http(client, base, clip["text"], args.voice)
            with wave.open(io.BytesIO(wav), "rb") as w:
                rate = w.getframerate()
                raw = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
            audio = _resample_to_16k(raw, rate)
            name = f"{clip['id']}.wav"
            (out / name).write_bytes(_wav_bytes(audio, SAMPLE_RATE))
            rows.append({**clip, "file": name, "seconds": round(len(audio) / SAMPLE_RATE, 2)})
            print(f"{name}: {rows[-1]['seconds']} s  {clip['text']}")
    (out / "manifest.json").write_text(json.dumps({"voice": args.voice or "default", "clips": rows}, indent=2))


async def _whisper_http(client, base: str, audio_wav: bytes, language: str | None) -> tuple[str, float]:
    data = {"lane": "interactive"}
    if language:
        data["language"] = language
    t0 = time.perf_counter()
    resp = await client.post(f"{base}/transcribe", files={"file": ("clip.wav", audio_wav, "audio/wav")}, data=data)
    resp.raise_for_status()
    return resp.json().get("text", ""), time.perf_counter() - t0


async def _bench_whisper_http(client, base: str, clips, runs: int, language: str | None) -> dict[str, Any]:
    health = (await client.get(f"{base}/health")).json()
    wavs = {c["id"]: _wav_bytes(c["audio"], SAMPLE_RATE) for c in clips}
    await _whisper_http(client, base, wavs[clips[0]["id"]], language)  # warm
    rows = []
    for clip in clips:
        if not clip["complete"]:
            continue
        times, heard = [], ""
        for _ in range(runs):
            heard, took = await _whisper_http(client, base, wavs[clip["id"]], language)
            times.append(_ms(took))
        rows.append({"clip": clip["id"], "seconds": clip["seconds"], "ms": _stats(times), "wer": word_error_rate(clip["text"], heard)})
    return {"url": base, "model": health.get("model"), "rows": rows}


async def _bench_tts_http(client, base: str, runs: int) -> dict[str, Any]:
    await _tts_http(client, base, "Warming up.")
    rows = {}
    for key in ("clause", "short", "long"):
        times, seconds = [], 0.0
        for _ in range(runs):
            wav, took = await _tts_http(client, base, TTS_TEXTS[key])
            times.append(_ms(took))
            with wave.open(io.BytesIO(wav), "rb") as w:
                seconds = w.getnframes() / w.getframerate()
        rows[key] = {"chars": len(TTS_TEXTS[key]), "audio_s": round(seconds, 2), "ms": _stats(times)}
    return {"url": base, "rows": rows}


_CLAUSE_END = re.compile(r"[,;:.!?](\s|$)")
_SENTENCE_END = re.compile(r"[.!?](\s|$)")


async def _bench_model(args: argparse.Namespace) -> dict[str, Any]:
    """Time to first token of the voice model, through Promptly's own provider code.

    Reads which model fills the voice role (else the default chat model, else the
    first enabled model of the first enabled provider). Changes nothing.
    """
    from sqlalchemy import select

    from app.app_settings.defaults import load_effective_defaults
    from app.chat.base_prompt import VOICE_SYSTEM_PROMPT
    from app.chat.router import VOICE_MAX_TOKENS
    from app.database import SessionLocal
    from app.models_config.models import ModelProvider
    from app.models_config.provider import ChatMessage, TextDelta, model_router

    async with SessionLocal() as db:
        defaults = await load_effective_defaults(db)
        provider, model_id, role = None, None, None
        if args.model:
            name, _, model_id = args.model.partition(":")
            provider = (await db.execute(select(ModelProvider).where(ModelProvider.name == name))).scalar_one_or_none()
            role = "--model"
        elif defaults.voice_configured:
            provider, model_id, role = await db.get(ModelProvider, defaults.voice_provider_id), defaults.voice_model_id, "voice"
        elif defaults.default_chat_configured:
            provider, model_id, role = await db.get(ModelProvider, defaults.default_chat_provider_id), defaults.default_chat_model_id, "default chat"
        else:
            for row in (await db.execute(select(ModelProvider).where(ModelProvider.enabled.is_(True)))).scalars():
                enabled = row.enabled_models or []
                if enabled:
                    provider, model_id, role = row, enabled[0], "first enabled model"
                    break
        if provider is None or not model_id:
            return {"skipped": "No model is set up on this server."}
        db.expunge(provider)

    rows = []
    for prompt in MODEL_PROMPTS:
        for _ in range(args.model_runs):
            t0 = time.perf_counter()
            ttft = clause = sentence = None
            text = ""
            async for ev in model_router.stream_chat_events(
                provider=provider,
                model_id=model_id,
                messages=[ChatMessage(role="user", content=prompt)],
                system=VOICE_SYSTEM_PROMPT,
                temperature=0.7,
                max_tokens=VOICE_MAX_TOKENS,
            ):
                if not isinstance(ev, TextDelta) or not ev.text:
                    continue
                now = time.perf_counter() - t0
                text += ev.text
                if ttft is None and text.strip():
                    ttft = now
                if clause is None and len(_words(text)) >= 4 and _CLAUSE_END.search(text):
                    clause = now
                if sentence is None and _SENTENCE_END.search(text):
                    sentence = now
            total = time.perf_counter() - t0
            rows.append(
                {
                    "prompt": prompt,
                    "ttft_ms": _ms(ttft) if ttft else None,
                    "first_clause_ms": _ms(clause or total),
                    "first_sentence_ms": _ms(sentence or total),
                    "total_ms": _ms(total),
                    "words": len(_words(text)),
                    "reply": text.strip()[:200],
                }
            )
    return {
        "provider": provider.name,
        "provider_type": provider.type,
        "model": model_id,
        "role": role,
        "rows": rows,
        "ttft_ms": _stats([r["ttft_ms"] for r in rows if r["ttft_ms"]]),
        "first_clause_ms": _stats([r["first_clause_ms"] for r in rows]),
        "first_sentence_ms": _stats([r["first_sentence_ms"] for r in rows]),
    }


async def cmd_run(args: argparse.Namespace) -> None:
    """Today's path over HTTP (whisper, tts) and the voice model's first token."""
    import httpx

    from app.config import get_settings

    settings = get_settings()
    clips = _load_clips(args.clips)
    result: dict[str, Any] = {"when": time.strftime("%Y-%m-%d %H:%M:%S"), "load_before": _load()}
    async with httpx.AsyncClient(timeout=120) as client:
        if not args.skip_whisper:
            result["whisper_http"] = [
                await _bench_whisper_http(client, url.rstrip("/"), clips, args.runs, args.language)
                for url in (args.whisper_url or [settings.WHISPER_URL])
            ]
        if not args.skip_tts:
            result["tts_http"] = await _bench_tts_http(client, (args.tts_url or settings.TTS_URL).rstrip("/"), args.runs)
    if not args.skip_model:
        result["model"] = await _bench_model(args)
    result["load_after"] = _load()
    _write_json(args.json, result)


# ------------------------------------------------------- whisper image: probes


def _whisper_model(name: str, threads: int, workers: int):
    from faster_whisper import WhisperModel

    return WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads, num_workers=workers)


def _transcribe(model, audio, *, final: bool, language: str | None) -> str:
    # A final pass is what /transcribe does today; a partial is the live lane's
    # quick greedy re-decode of the audio so far.
    if final:
        segments, _ = model.transcribe(audio, language=language, vad_filter=True, condition_on_previous_text=False)
    else:
        segments, _ = model.transcribe(
            audio,
            language=language,
            vad_filter=False,
            beam_size=1,
            without_timestamps=True,
            condition_on_previous_text=False,
        )
    return "".join(s.text for s in segments).strip()


def _live_pass_times(model, audio, language: str | None, window_s: float) -> list[float]:
    """Re-decode the trailing window every LIVE_STEP_S of audio, as the live lane would."""
    step = int(LIVE_STEP_S * SAMPLE_RATE)
    window = int(window_s * SAMPLE_RATE)
    times = []
    for end in range(step, len(audio) + 1, step):
        t0 = time.perf_counter()
        _transcribe(model, audio[max(0, end - window) : end], final=False, language=language)
        times.append(_ms(time.perf_counter() - t0))
    return times


def cmd_whisper(args: argparse.Namespace) -> None:
    clips = _load_clips(args.clips)
    complete = [c for c in clips if c["complete"]]
    longest = max(complete, key=lambda c: c["seconds"])
    threads = args.threads if args.threads is not None else int(os.environ.get("WHISPER_CPU_THREADS", "0"))
    out: dict[str, Any] = {
        "when": time.strftime("%Y-%m-%d %H:%M:%S"),
        "omp_threads": os.environ.get("OMP_NUM_THREADS"),
        "cpu_threads": threads,
        "load_before": _load(),
        "models": {},
    }
    for name in args.models.split(","):
        t0 = time.perf_counter()
        model = _whisper_model(name, threads, workers=2)
        entry: dict[str, Any] = {"load_s": round(time.perf_counter() - t0, 1), "rss_mb": _rss_mb()}
        t0 = time.perf_counter()
        _transcribe(model, complete[0]["audio"], final=True, language=args.language)
        entry["first_pass_ms"] = _ms(time.perf_counter() - t0)

        finals, partials = [], []
        for clip in complete:
            times, heard = [], ""
            for _ in range(args.runs):
                t0 = time.perf_counter()
                heard = _transcribe(model, clip["audio"], final=True, language=args.language)
                times.append(_ms(time.perf_counter() - t0))
            ptimes = []
            for _ in range(args.runs):
                t0 = time.perf_counter()
                _transcribe(model, clip["audio"], final=False, language=args.language)
                ptimes.append(_ms(time.perf_counter() - t0))
            finals.append({"clip": clip["id"], "seconds": clip["seconds"], "ms": _stats(times), "wer": word_error_rate(clip["text"], heard), "heard": heard})
            partials.append({"clip": clip["id"], "seconds": clip["seconds"], "ms": _stats(ptimes)})
        entry["final"] = finals
        entry["partial"] = partials
        if args.language is None:
            t0 = time.perf_counter()
            _transcribe(model, longest["audio"], final=True, language="en")
            entry["final_lang_en_ms"] = _ms(time.perf_counter() - t0)

        # The live lane: one speaker, then two at once (two live slots).
        one = _live_pass_times(model, longest["audio"], args.language, args.window)
        entry["live_one"] = {"clip": longest["id"], "seconds": longest["seconds"], "pass_ms": _stats(one), "duty": round(sum(one) / 1000.0 / longest["seconds"], 2)}
        both: list[list[float]] = [[], []]

        def speaker(i: int) -> None:
            both[i] = _live_pass_times(model, longest["audio"], args.language, args.window)

        workers = [threading.Thread(target=speaker, args=(i,)) for i in range(2)]
        t0 = time.perf_counter()
        for w in workers:
            w.start()
        for w in workers:
            w.join()
        entry["live_two"] = {
            "pass_ms": _stats(both[0] + both[1]),
            "wall_s": round(time.perf_counter() - t0, 2),
            "duty": round(max(sum(both[0]), sum(both[1])) / 1000.0 / longest["seconds"], 2),
        }
        entry["rss_mb_after"] = _rss_mb()
        out["models"][name] = entry
        del model
    out["load_after"] = _load()
    _write_json(args.json, out)


def _smart_turn_model(cache: Path) -> Path:
    path = cache / "smart-turn-v3.2-cpu.onnx"
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        with urllib.request.urlopen(SMART_TURN_URL, timeout=120) as resp, open(tmp, "wb") as fh:
            fh.write(resp.read())
        tmp.replace(path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != SMART_TURN_SHA256:
        path.unlink()
        raise SystemExit(f"Smart Turn model hash mismatch: {digest}")
    return path


def _smart_turn_features(audio, extractor):
    """Whisper log-mel features of the last 8 s, zero-padded at the front (as Pipecat's inference.py)."""
    import numpy as np

    n = 8 * SAMPLE_RATE
    audio = audio[-n:]
    if len(audio) < n:
        audio = np.pad(audio, (n - len(audio), 0))
    audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)  # do_normalize
    feats = extractor(audio.astype(np.float32), padding=0)[:, :800]
    if feats.shape[1] < 800:
        feats = np.pad(feats, ((0, 0), (0, 800 - feats.shape[1])))
    return feats[None, :, :].astype(np.float32)


def cmd_smart_turn(args: argparse.Namespace) -> None:
    import numpy as np
    import onnxruntime as ort
    from faster_whisper.feature_extractor import FeatureExtractor

    path = _smart_turn_model(Path(args.cache))
    so = ort.SessionOptions()
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.inter_op_num_threads = 1
    if args.threads:
        so.intra_op_num_threads = args.threads
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])
    name = session.get_inputs()[0].name
    extractor = FeatureExtractor(feature_size=80, chunk_length=8)
    clips = _load_clips(args.clips)
    silence = np.zeros(int(0.25 * SAMPLE_RATE), dtype=np.float32)  # the 250 ms that triggers the check

    session.run(None, {name: _smart_turn_features(np.concatenate([clips[0]["audio"], silence]), extractor)})
    rows, feature_ms, model_ms = [], [], []
    for clip in clips:
        audio = np.concatenate([clip["audio"], silence])
        prob = 0.0
        for _ in range(args.runs):
            t0 = time.perf_counter()
            feats = _smart_turn_features(audio, extractor)
            t1 = time.perf_counter()
            prob = float(session.run(None, {name: feats})[0].reshape(-1)[0])
            t2 = time.perf_counter()
            feature_ms.append(_ms(t1 - t0))
            model_ms.append(_ms(t2 - t1))
        rows.append({"clip": clip["id"], "complete": clip["complete"], "probability": round(prob, 3), "says_complete": prob > 0.5})
    _write_json(
        args.json,
        {
            "model": path.name,
            "sha256": SMART_TURN_SHA256,
            "intra_threads": args.threads or "default",
            "features_ms": _stats(feature_ms),
            "model_ms": _stats(model_ms),
            "total_ms_median": round(statistics.median(feature_ms) + statistics.median(model_ms), 1),
            "rows": rows,
            "right": sum(1 for r in rows if r["says_complete"] == r["complete"]),
            "of": len(rows),
            "load": _load(),
        },
    )


# ---------------------------------------------------------- tts image: probes


def cmd_kokoro(args: argparse.Namespace) -> None:
    from kokoro_onnx import Kokoro

    folder = Path(args.model_dir)
    t0 = time.perf_counter()
    if args.threads:
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = args.threads
        session = ort.InferenceSession(str(folder / "kokoro-v1.0.onnx"), sess_options=so, providers=["CPUExecutionProvider"])
        kokoro = Kokoro.from_session(session, str(folder / "voices-v1.0.bin"))
    else:  # as the tts service does: onnxruntime picks (one thread per core)
        kokoro = Kokoro(str(folder / "kokoro-v1.0.onnx"), str(folder / "voices-v1.0.bin"))
    out: dict[str, Any] = {
        "load_s": round(time.perf_counter() - t0, 1),
        "voice": args.voice,
        "threads": args.threads or "default",
        "load_before": _load(),
        "create": {},
        "stream": {},
    }
    kokoro.create("Warming up.", voice=args.voice, speed=1.0, lang="en-us")

    for key, text in TTS_TEXTS.items():
        times, seconds = [], 0.0
        for _ in range(args.runs):
            t0 = time.perf_counter()
            samples, rate = kokoro.create(text, voice=args.voice, speed=1.0, lang="en-us")
            times.append(_ms(time.perf_counter() - t0))
            seconds = len(samples) / rate
        out["create"][key] = {"chars": len(text), "audio_s": round(seconds, 2), "ms": _stats(times), "rtf": round(statistics.median(times) / 1000.0 / seconds, 3)}

    async def stream_once(text: str) -> tuple[float, float, int]:
        t0 = time.perf_counter()
        first = None
        chunks = 0
        async for _samples, _rate in kokoro.create_stream(text, voice=args.voice, speed=1.0, lang="en-us"):
            chunks += 1
            if first is None:
                first = time.perf_counter() - t0
        return _ms(first or 0.0), _ms(time.perf_counter() - t0), chunks

    for key in ("short", "long", "paragraph"):
        firsts, totals, chunks = [], [], 0
        for _ in range(args.runs):
            first, total, chunks = asyncio.run(stream_once(TTS_TEXTS[key]))
            firsts.append(first)
            totals.append(total)
        out["stream"][key] = {"chars": len(TTS_TEXTS[key]), "chunks": chunks, "first_chunk_ms": _stats(firsts), "total_ms": _stats(totals)}
    out["load_after"] = _load()
    _write_json(args.json, out)


# ------------------------------------------------------------------------ CLI


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="app.talk.bench", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("clips", help="backend image: make the test clips with the tts service")
    p.add_argument("--out", required=True)
    p.add_argument("--tts-url")
    p.add_argument("--voice")

    p = sub.add_parser("run", help="backend image: today's HTTP path and the voice model's first token")
    p.add_argument("--clips", required=True)
    p.add_argument("--json")
    p.add_argument("--runs", type=int, default=5)
    p.add_argument("--whisper-url", action="append", help="repeat to compare several whisper services")
    p.add_argument("--tts-url")
    p.add_argument("--language", default="en")
    p.add_argument("--model", help="'Provider name:model id' instead of the voice role")
    p.add_argument("--model-runs", type=int, default=3, help="per prompt; keep it small, these are real calls")
    p.add_argument("--skip-whisper", action="store_true")
    p.add_argument("--skip-tts", action="store_true")
    p.add_argument("--skip-model", action="store_true")

    p = sub.add_parser("whisper", help="whisper image: per pass, partials and the live lane, in-process")
    p.add_argument("--clips", required=True)
    p.add_argument("--json")
    p.add_argument("--models", default="base,small")
    p.add_argument("--runs", type=int, default=5)
    p.add_argument("--threads", type=int, help="CTranslate2 threads per pass (default: as the service)")
    p.add_argument("--language", default="en", help="'auto' to let Whisper detect it")
    p.add_argument("--window", type=float, default=8.0, help="seconds the live lane re-decodes")

    p = sub.add_parser("smart-turn", help="whisper image: Smart Turn v3.2 time and answers on the clips")
    p.add_argument("--clips", required=True)
    p.add_argument("--json")
    p.add_argument("--runs", type=int, default=10)
    p.add_argument("--threads", type=int, default=1, help="onnxruntime intra-op threads (1 was fastest; 0 = its default)")
    p.add_argument("--cache", default="/root/.cache/smart-turn")

    p = sub.add_parser("kokoro", help="tts image: create per clause and create_stream to its first chunk")
    p.add_argument("--json")
    p.add_argument("--runs", type=int, default=5)
    p.add_argument("--voice", default=os.environ.get("TTS_VOICE", "af_heart"))
    p.add_argument("--model-dir", default=os.environ.get("TTS_MODEL_DIR", "/root/.cache/kokoro"))
    p.add_argument("--threads", type=int, default=0, help="onnxruntime threads (default: one per core, as the service)")

    args = parser.parse_args(argv)
    if getattr(args, "language", None) == "auto":
        args.language = None
    commands: dict[str, Callable[[argparse.Namespace], Any]] = {
        "clips": lambda a: asyncio.run(cmd_clips(a)),
        "run": lambda a: asyncio.run(cmd_run(a)),
        "whisper": cmd_whisper,
        "smart-turn": cmd_smart_turn,
        "kokoro": cmd_kokoro,
    }
    commands[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
