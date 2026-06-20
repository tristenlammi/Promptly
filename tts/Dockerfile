# syntax=docker/dockerfile:1.6
# ============================================================
# Promptly text-to-speech worker (Kokoro-82M via kokoro-onnx).
#
# Wraps Kokoro in a tiny FastAPI service. Runs on the internal
# ``promptly`` network; only the backend reaches it at
# http://tts:8000. CPU/onnxruntime by default — no GPU or torch.
#
# Model weights (~330 MB) download on first start into /root/.cache,
# which compose maps to ./data/tts so it's a one-time cost.
# ============================================================
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TTS_MODEL_DIR=/root/.cache/kokoro

WORKDIR /app

# espeak-ng is Kokoro's fallback grapheme-to-phoneme backend. libgomp1
# is needed by onnxruntime's threadpool.
RUN apt-get update \
    && apt-get install -y --no-install-recommends espeak-ng libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py ./

EXPOSE 8000

# Single worker: the model lives in memory and synthesis is CPU-bound, so
# extra workers multiply RAM without helping the short, bursty workload.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
