# syntax=docker/dockerfile:1.6
# ============================================================
# Promptly photos-ml: understanding photos on your own box (Part E §E4.2).
#
# ONNX Runtime behind a tiny FastAPI service, on the internal ``promptly``
# network only (http://photos-ml:8000). Models are pinned by revision and
# checksum and download once, on first start, into /models — compose maps
# that to ./data/models.
# ============================================================
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PHOTOS_ML_MODEL_DIR=/models

WORKDIR /app

# libgomp1: onnxruntime's thread pool.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-deps rapidocr==3.9.2

COPY server.py ./

EXPOSE 8000

# One worker: the models live in memory and inference is CPU-bound.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
