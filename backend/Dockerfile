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
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

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
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
