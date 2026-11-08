# syntax=docker/dockerfile:1.6
# ============================================================
# Promptly speech-to-text worker (faster-whisper).
#
# Wraps faster-whisper in a tiny FastAPI service. Runs on the
# internal ``promptly`` network; only the backend reaches it at
# http://whisper:8000. CPU/int8 by default so it works on a plain
# homelab box; flip WHISPER_DEVICE=cuda for GPU.
#
# The model weights download on first start into /root/.cache,
# which compose maps to ./data/whisper so it's a one-time cost.
# ============================================================
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    # Keep Hugging Face fully offline-friendly + predictable cache path.
    HF_HOME=/root/.cache/huggingface \
    OMP_NUM_THREADS=4

WORKDIR /app

# ffmpeg is belt-and-braces: PyAV (pulled in by faster-whisper) bundles
# its own decoders, but having the system binary present avoids any
# codec surprises with exotic browser containers. libopus (BSD) decodes the
# Opus packets Talk can stream into /live.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libopus0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py live.py ./

EXPOSE 8000

# Single worker: the model holds ~hundreds of MB of weights in memory,
# so forking extra workers multiplies RAM for little gain on the short,
# bursty dictation workload. CTranslate2 already parallelises internally.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
