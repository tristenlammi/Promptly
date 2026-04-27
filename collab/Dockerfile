# syntax=docker/dockerfile:1.6
#
# Promptly collaboration server (Hocuspocus).
#
# A small Node service that terminates Y.js sync websockets, persists
# the CRDT to Postgres, and debounces HTML snapshot writes back to the
# FastAPI backend. It only speaks to services inside the ``promptly``
# docker network; nginx proxies /api/collab/* to the websocket listener
# on port 1234 internally.

FROM node:20-alpine AS base
WORKDIR /app

# Install deps first so `npm install` layer is reusable.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source.
COPY src ./src

# Healthcheck endpoint lives on the same port as the websocket listener
# (Hocuspocus exposes a tiny HTTP side on the same server). The compose
# healthcheck just pokes it to confirm the process is alive.
ENV PORT=1234
EXPOSE 1234

USER node
CMD ["node", "src/server.js"]
