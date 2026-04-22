#!/bin/sh
# ============================================================
# Ollama bootstrap entrypoint
# ============================================================
#
# Wraps the upstream ``ollama serve`` entrypoint with a one-shot
# auto-pull of the default embedding model so the Custom Models
# RAG pipeline works on a fresh ``docker compose up`` with zero
# manual steps.
#
# Idempotent: ``ollama pull`` is a no-op when the model is
# already on disk, so the bootstrap re-runs cheaply on every
# container restart.
#
# Why a script instead of a one-liner in compose? The upstream
# ``ollama/ollama`` image's CMD is ``serve``, but ``ollama pull``
# needs the server to be running first. We have to start the
# server, wait for it to bind, pull, then ``wait`` so the
# container's PID 1 stays alive for the foreground process.
# A two-step entrypoint is the cleanest way to express that
# without either racing the server boot or backgrounding the
# server (which would make ``docker stop`` slow).
# ============================================================

set -e

MODEL="${OLLAMA_DEFAULT_EMBEDDING_MODEL:-nomic-embed-text}"

echo "[ollama-bootstrap] starting ollama serve in background..."
ollama serve &
SERVER_PID=$!

# Wait until the API is ready before pulling. ``ollama list``
# round-trips against the local server and returns non-zero
# until ``serve`` is bound. 60s is generous — the server
# normally responds within a second or two.
for i in $(seq 1 60); do
  if ollama list >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! ollama list >/dev/null 2>&1; then
  echo "[ollama-bootstrap] WARN: ollama did not become ready within 60s; skipping auto-pull"
else
  echo "[ollama-bootstrap] pulling default embedding model: ${MODEL}"
  # ``|| true`` so a transient network failure (no internet on
  # first boot) doesn't crash the container — the user can
  # always retry later via the Local Models UI in Phase 2.
  ollama pull "${MODEL}" || echo "[ollama-bootstrap] WARN: pull failed; will retry on next request"
fi

# Re-attach to the server so the container exits when ``ollama
# serve`` exits (rather than zombieing the script process).
echo "[ollama-bootstrap] handing off to ollama serve (pid ${SERVER_PID})"
wait ${SERVER_PID}
