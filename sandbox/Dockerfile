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

# Two users. The server runs as root but with almost every capability
# dropped (compose keeps only setuid/setgid/chown/dac_override/fowner/kill),
# and starts each job as ``sandboxjob`` (uid 10002), which has no
# capabilities and a different uid, so the model's code can't read the
# server's /proc/<pid>/environ (the job secret) or signal it.
# ``sandboxer`` (10001) is kept for anyone running the image without the
# compose caps; the server then warns that jobs share its uid.
RUN useradd --create-home --uid 10001 sandboxer \
    && useradd --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --uid 10002 sandboxjob \
    && mkdir -p /sandbox/run \
    && chmod 0711 /sandbox/run
ENV SANDBOX_JOB_UID=10002 \
    SANDBOX_JOB_GID=10002

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
