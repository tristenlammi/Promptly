# syntax=docker/dockerfile:1.6

# ---- Base image with Python + system deps ----
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        libpq-dev \
        libglib2.0-0 \
        libgl1 \
        # ffmpeg/ffprobe: the meeting-notes worker probes uploaded
        # recordings and splits them into Whisper-sized Opus chunks.
        ffmpeg \
        # exiftool: lossless metadata removal (location, camera serials)
        # when a photo leaves Promptly — public links, AI providers —
        # while the stored original stays byte-exact.
        libimage-exiftool-perl \
        # restic (+ ssh for SFTP targets): off-site backup of the database
        # dumps, uploads and config from Admin → Backups (WP-2.3). The
        # distro package gets Debian's security updates.
        restic \
        openssh-client \
        # WeasyPrint (a Doc's PDF, WP-6.4): Pango + HarfBuzz-subset, and
        # fonts so text isn't boxes — Liberation (metric twins of Arial /
        # Times / Courier), DejaVu (Latin, Greek, Cyrillic), Noto CJK.
        libpango-1.0-0 \
        libpangoft2-1.0-0 \
        libharfbuzz-subset0 \
        fonts-liberation \
        fonts-dejavu-core \
        fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# pg_dump for the built-in database backups (before every migration and
# nightly). It must match the server's major version — a newer pg_dump
# writes dumps an older server can refuse to restore — so pin the client
# for the pgvector/pg15 server from the PostgreSQL project's own apt repo
# (Debian trixie only ships 17). Bump together with the postgres image.
ARG PG_CLIENT_MAJOR=15
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-${PG_CLIENT_MAJOR} \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

# Pre-download the background-removal model into the image so the first
# "Remove background" request doesn't reach out to the network (keeps the
# feature self-contained / offline). U2NET_HOME is rembg's model cache dir
# (all models, despite the name). REMBG_MODEL selects the model and
# persists to runtime; default is isnet-general-use (~176 MB, crisp edges,
# fast on CPU). Override (env/build-arg) with birefnet-general for top
# quality (~1 GB, slower) or u2netp (~5 MB) for a minimal image.
ENV U2NET_HOME=/app/.u2net \
    REMBG_MODEL=isnet-general-use
RUN python -c "import os; from rembg import new_session; new_session(os.environ['REMBG_MODEL'])"

# ---- Development target (hot reload via volume mount) ----
FROM base AS dev
COPY . .
# Normalise line endings (Windows git clients may introduce CRLF) and ensure exec bit.
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh \
    && mkdir -p /app/uploads /app/whiteboard
EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

# ---- Production target ----
FROM base AS prod
COPY . .
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh \
    && mkdir -p /app/uploads /app/whiteboard
EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]
# Single worker on purpose. The SSE streaming layer (app/chat/stream_runner.py)
# keeps each in-flight generation's event buffer in *process memory* so a
# client can navigate away and reconnect to the live tail. With >1 uvicorn
# worker the background task + its buffer live in one worker while reconnect
# requests load-balance across all of them, so ~half land on a worker that has
# no session and error out ("Stream not found"). One async worker handles a
# self-hosted team's concurrency fine (the work is I/O-bound — awaiting the LLM
# provider, DB, Redis). Multi-worker/multi-container scaling would need a
# Redis-backed event log instead.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
