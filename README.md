# Promptly

A self-hosted, multi-user AI chat workspace. Bring-your-own-key (OpenRouter, Anthropic, OpenAI), full conversation history, file attachments and AI-generated artefacts (PDFs, images), tool-calling (web search, page fetch), MFA, audit logging, and admin analytics.

This README is the **operator's runbook** — everything you need to deploy Promptly to a private server for a small group of users (~10) and keep it healthy. It is intentionally short. For the deeper product spec see `Promptly.txt`.

---

## Quick start (one command)

You need a Linux server with `docker` + `docker compose` v2 and (for production) a domain name pointing at it.

```bash
git clone https://github.com/<your-username>/Promptly.git promptly
cd promptly
./scripts/setup.sh chat.example.com    # or: ./scripts/setup.sh   for localhost
```

That's it. The script:

1. Verifies Docker is installed and running.
2. Generates a fresh `.env` with strong random `SECRET_KEY`, `SEARXNG_SECRET`, and `POSTGRES_PASSWORD`.
3. Sets `DOMAIN` to whatever you passed (or `localhost`).
4. Builds and starts the full stack.
5. Waits for the backend health check to go green.

Open `http://chat.example.com` (or `http://localhost`) — the first visit launches a setup wizard that creates the bootstrap admin account. Subsequent users join via the admin's invite flow (Account → Invites). Open registration is intentionally disabled.

> **Windows / Docker Desktop?** Use `.\scripts\setup.ps1` instead — same behaviour, PowerShell flavour.

### Prefer to do it manually?

```bash
cp .env.example .env
# edit .env — at minimum fill in SECRET_KEY, SEARXNG_SECRET, POSTGRES_PASSWORD, DOMAIN
docker compose up -d
```

Alembic migrations run automatically on backend boot via `backend/entrypoint.sh`, so there's no separate "init the database" step.

### TLS

Production deployments need HTTPS. Pick one:

1. **Cloudflare Tunnel (easiest).** `cloudflared tunnel --url http://localhost:80` and point your DNS at the tunnel.
2. **Caddy / Traefik in front of nginx.** They handle Let's Encrypt automatically — proxy them to `localhost:${NGINX_HTTP_PORT}`.
3. **Add `:443` to nginx directly.** See [TLS termination](#tls-termination) below.

---

## Required `.env` values

| Variable | What it does | Notes |
|---|---|---|
| `SECRET_KEY` | JWT signing + cookie integrity | **Must** be 32+ bytes of true randomness. Backend refuses to boot in production with a weak value. Generate with `openssl rand -hex 32`. |
| `DOMAIN` | The public hostname users type into a browser | Drives `ALLOWED_ORIGINS` for CORS. Must match the real origin **exactly**, including subdomain. |
| `POSTGRES_PASSWORD` | Postgres superuser password | Random 24+ chars. Only ever read by the backend container over the internal Docker network. |
| `SEARXNG_SECRET` | SearXNG instance secret | `openssl rand -hex 32`. |
| `OPENROUTER_API_KEY` | (Optional) Default OpenRouter key for all users | Admins can also add provider keys per-provider in the Models tab. Leave blank if you only want admin-managed providers. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | (Optional) Direct provider keys | Same — admin-managed in the Models tab is the recommended path. |
| `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` | (Optional) Alternate search providers | SearXNG is the default and runs in-cluster, no key needed. |
| `SINGLE_USER_MODE` | Bypass auth entirely for solo personal setups | **Leave `false`** for any multi-user deployment. When `true` the backend stops checking JWTs. |
| `NGINX_HTTP_PORT` / `NGINX_HTTPS_PORT` | Host ports nginx binds to | Override if 80/443 are already in use. |

---

## TLS termination

The shipped `nginx/nginx.conf` listens on port 80 only. Pick one of:

1. **Cloudflare Tunnel (recommended for small deployments).** Install `cloudflared`, run `cloudflared tunnel --url http://localhost:80` against your domain. Cloudflare terminates TLS at their edge and tunnels to nginx on plain HTTP over the loopback. No certs to renew, free for personal use.
2. **Caddy / Traefik in front of nginx.** Run them on the host with `:443` and proxy to `localhost:${NGINX_HTTP_PORT}`. They handle Let's Encrypt automatically.
3. **Add `:443` to nginx directly.** Drop a fullchain + key into `nginx/ssl/`, add a `server { listen 443 ssl; ... }` block to `nginx/nginx.conf`, and run `certbot` on the host. More moving parts; only worth it if you can't use #1 or #2.

---

## Day-2 operations

### Health

`GET /api/health` (proxied through nginx) returns `200` only when Postgres, Redis, and SearXNG are all reachable. JSON body breaks down per-component status. Wire this into your uptime monitor (UptimeRobot, BetterStack, Healthchecks.io).

```bash
curl -s https://chat.example.com/api/health | jq .
```

The compose file also runs container-level healthchecks. `docker compose ps` shows `(healthy)` against each service when things are good.

### Backups

Two volumes hold all stateful data:

- `postgres_data` — every conversation, message, account, audit row, settings.
- `uploads` — every uploaded and AI-generated file (images, PDFs).

A nightly cron is enough for a small deployment:

```bash
# /etc/cron.daily/promptly-backup
#!/bin/sh
set -eu
BACKUP_DIR=/var/backups/promptly
mkdir -p "$BACKUP_DIR"
DATE=$(date +%Y%m%d-%H%M%S)

# Postgres logical dump (compressed, restorable across PG versions).
docker compose -f /srv/promptly/docker-compose.yml exec -T postgres \
  pg_dump -U promptly --format=custom promptly \
  | gzip > "$BACKUP_DIR/db-$DATE.sql.gz"

# Uploaded + generated files.
docker run --rm \
  -v promptly_uploads:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/uploads-$DATE.tar.gz" -C /data .

# Keep 14 days.
find "$BACKUP_DIR" -name 'db-*.sql.gz'      -mtime +14 -delete
find "$BACKUP_DIR" -name 'uploads-*.tar.gz' -mtime +14 -delete
```

Don't forget to copy `/var/backups/promptly` off-box (rsync to a NAS, S3, Backblaze, etc.).

### Restore

```bash
# Database
gunzip < db-YYYYMMDD-HHMMSS.sql.gz | docker compose exec -T postgres \
  pg_restore -U promptly -d promptly --clean --if-exists

# Uploads
docker run --rm \
  -v promptly_uploads:/data \
  -v /var/backups/promptly:/backup \
  alpine sh -c "cd /data && tar xzf /backup/uploads-YYYYMMDD-HHMMSS.tar.gz"
```

### Upgrade

```bash
cd /srv/promptly
git pull
docker compose build
docker compose up -d
```

The backend's `entrypoint.sh` runs `alembic upgrade head` on every boot, so schema migrations apply automatically. The first request after boot may be slow while migrations finish — health checks will go yellow, then green.

Always take a backup **before** an upgrade. Migrations are forward-only; downgrades drop columns/tables.

### Logs

```bash
docker compose logs -f backend         # live tail
docker compose logs --since=1h backend # last hour
```

The backend writes one JSON object per log line (after Phase 2 lands), so `jq` is your friend:

```bash
docker compose logs backend --since=1h --no-color \
  | jq -r 'select(.level=="ERROR") | "\(.ts) \(.user_id // "-") \(.route // "-") \(.message)"'
```

Admins also get an in-app **Live Console** (Admin → Console) with the same data + filtering + error grouping.

### Common operational tasks

```bash
# Open a Postgres shell
docker compose exec postgres psql -U promptly -d promptly

# Open a Python shell with the backend env
docker compose exec backend python

# Force-rebuild just one service after a code change
docker compose build backend && docker compose up -d backend

# Run an ad-hoc Alembic command (e.g. preview the next migration)
docker compose exec backend alembic current
docker compose exec backend alembic history --verbose
```

---

## What is in the box

- **`backend/`** — FastAPI, SQLAlchemy 2.0 async, Alembic. All schema migrations live in `backend/alembic/versions/` and run on container boot.
- **`frontend/`** — React 18 + Vite + TypeScript + TanStack Query + Zustand + Tailwind. Built into a static bundle and served by `frontend`'s nginx.
- **`nginx/`** — The public-facing reverse proxy. Routes `/api/*` to the backend, everything else to the frontend container.
- **`searxng/`** — Self-hosted SearXNG metasearch instance for the web-search tool. No tracking, no Google Programmable Search dependency by default.
- **`docker-compose.yml`** — Production compose. Backend and frontend are not exposed on host ports, only nginx is.
- **`docker-compose.dev.yml`** — Dev compose, runs Vite in HMR mode and exposes the backend directly.

---

## Troubleshooting

**Backend refuses to start with "insecure production configuration".** Read the traceback — it lists every fixable problem at once (weak `SECRET_KEY`, wildcard `ALLOWED_ORIGINS`, insecure cookie settings). Fix them in `.env` and restart. This is intentional and saves you from accidentally exposing a misconfigured deployment.

**`SearXNG` container unhealthy on first boot.** SearXNG sometimes can't write `/etc/searxng/uwsgi.ini` with `cap_drop: ALL`. Workaround: temporarily comment out the `cap_drop` block in `docker-compose.yml`, run `docker compose up -d searxng`, then restore the cap-drop and recreate.

**Login fails immediately with "Too many requests".** The Redis-backed rate limiter is intentionally aggressive. Wait 60 seconds, or `docker compose exec redis redis-cli FLUSHDB` to clear all rate-limit counters in dev.

**Want to disable web search entirely.** Set `DEFAULT_SEARCH_PROVIDER=none` in `.env` (provider gating is enforced server-side; the toggle in the chat UI also has an "Off" mode per-conversation).

**Upgrades break "old browser tabs" with stale React errors.** The service worker takes control of open tabs immediately on activation, so a hard refresh (Ctrl+Shift+R) usually fixes it. If it persists, `docker compose restart frontend`.

---

## Security notes

- Registration is invite-only — open `/register` returns 403. Admins issue invites from the Account page.
- All write endpoints require auth (`Bearer` JWT for the access token, HttpOnly cookie for the refresh token).
- Refresh tokens carry a `tv` claim tied to `User.token_version`. Bumping the column invalidates every outstanding session for that user immediately ("kick all sessions").
- Failed-login lockout after `LOCKOUT_THRESHOLD` attempts. Lockout is permanent until an admin unlocks via the Admin → Users page.
- Outbound HTTP from tools (`web_search`, `fetch_url`) goes through `app/net/safe_fetch.py` which blocks private IPs, validates redirect targets, and caps response sizes. The Docker-internal SearXNG hostname is on an explicit allowlist.
- Audit log (`auth_events` table) records every login attempt, lockout, refresh rejection, MFA attempt, and rate-limit trip. Visible to admins under Admin → Audit.

If you find a security issue, please open a private GitHub security advisory rather than a public issue.
