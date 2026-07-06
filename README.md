# Promptly

A self-hosted AI chat platform. Connect your own API keys, run local models, and keep your data on your own server.

![Promptly chat interface](docs/screenshots/chatinterface.png)

---

## What it does

- **Chat** with any AI model — OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, or local models via Ollama
- **Deep research** — breaks a question into sub-questions, fetches real page content, and writes a cited report
- **Study mode** — generates a full course on any topic, tutors you unit by unit, and gives you a timed final exam
- **Scheduled tasks** — set up recurring AI jobs on a cron schedule and notify you when done
- **Memory** — the AI remembers things across all your chats
- **Custom models** — wrap any base model with a custom persona and a knowledge library of your own files (RAG)
- **File Drive** — upload, organise, and share files with per-user storage quotas
- **Code interpreter** — executes Python in a sandboxed environment, attaches charts and outputs
- **Admin panel** — manage users, set token budgets, configure providers, view audit logs

---

## Install

**Requirements:** Docker and Docker Compose v2 (≥ 2.20). That's it — no `.env` to edit.

```bash
git clone https://github.com/tristenlammi/Promptly.git && cd Promptly && ./install.sh
```

(Windows PowerShell: `.\install.ps1`)

The script checks prerequisites, generates all secrets into `.env`, builds and
starts the stack, and waits for it to come up healthy. Then open
**http://localhost:8087** — the first-run wizard walks you through creating
your admin account (plus optional public URL, embeddings, and two-step
verification).

> Ports default to **8087** (HTTP) and **8488** (HTTPS).

### Install options

| Flag (bash / PowerShell) | Effect |
| --- | --- |
| `--no-ollama` / `-NoOllama` | Skip the bundled Ollama container. Use when you already run Ollama on the host (set `OLLAMA_URL` in `.env`, e.g. `http://host.docker.internal:11434`) or don't want local models at all. |
| `--no-search` / `-NoSearch` | Skip the bundled SearXNG container. Web search stays off until you add a Brave or Tavily API key under Admin → Settings. |
| `--minimal` / `-Minimal` | Both of the above. |

The choice is persisted as `COMPOSE_PROFILES` in `.env`, so a plain
`docker compose up -d` keeps honouring it. Re-run the install script with a
different flag to change your mind — everything else (secrets, data) is
preserved.

### Before exposing it publicly

The auto-generated `SECRET_KEY` is strong and unique per install, but the
Postgres/SearXNG defaults are only meant for a localhost box (the database is
never published to the host). Before you put Promptly behind a public domain,
seed real secrets — the boot guard will refuse a public `DOMAIN` with default
datastore credentials until you do:

```bash
cp .env.example .env
./install.sh          # or  .\install.ps1  on Windows — generates all secrets
```

`.env` always overrides the auto-generated values, so this is also how you pin
your own secrets or change ports/`DOMAIN`.

---

## GPU acceleration (optional)

If you have an NVIDIA GPU and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) installed, swap the `ollama` token for `gpu` in the `COMPOSE_PROFILES` line of `.env` (the CPU and GPU variants must not run together):

```bash
# .env
COMPOSE_PROFILES=gpu,search
```

```bash
docker compose stop ollama && docker compose up -d
```

---

## Updating

```bash
git pull
docker compose up -d --build
```

---

## Data

Everything persists in `./data/` next to the compose file — Postgres, Redis, Ollama models, and file uploads. Back that folder up and you have everything.
