# syntax=docker/dockerfile:1.6
# ============================================================
# Promptly code-interpreter sandbox.
#
# A minimal, network-isolated worker that executes model-written
# Python in a throwaway scratch dir with hard CPU / memory / time
# limits. It runs on an internal-only docker network (no internet,
# no Postgres/Redis), as a non-root user, with a read-only rootfs
# (writable scratch comes from a tmpfs mount in docker-compose).
# ============================================================
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Headless matplotlib — no display, render straight to files.
    MPLBACKEND=Agg \
    # Writable matplotlib config/cache dir inside the tmpfs scratch.
    MPLCONFIGDIR=/sandbox/run/.mpl \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Build deps for the scientific wheels are not needed — pandas/numpy/
# matplotlib all ship manylinux wheels for slim. Keep the image lean.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py ./

# Run as an unprivileged user. The scratch dir is a tmpfs mounted at
# runtime and chowned via the tmpfs uid option in compose; we create
# the mountpoint here so a read-only rootfs still has the path.
RUN useradd --create-home --uid 10001 sandboxer \
    && mkdir -p /sandbox/run \
    && chown -R sandboxer:sandboxer /sandbox
USER sandboxer

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
