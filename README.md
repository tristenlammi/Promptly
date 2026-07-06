<div align="center">

![Promptly](docs/screenshots/readme-banner.png)

**The self-hosted AI workspace.** Chat with any model, research with agents,
collaborate in Workspaces, talk out loud, automate the boring parts —
all on hardware you control.

[![Website](https://img.shields.io/badge/website-chatpromptly.com-D97757)](https://chatpromptly.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)
[![Deploy](https://img.shields.io/badge/deploy-docker%20compose-2496ED)](#install)

**[See it in action → chatpromptly.com](https://chatpromptly.com)**

</div>

---

## Install

One command. Any machine that runs Docker (Compose v2 ≥ 2.20).

```bash
git clone https://github.com/tristenlammi/Promptly.git && cd Promptly && ./install.sh
```

Windows PowerShell: `.\install.ps1`

The script generates all secrets, builds and starts the stack, and waits for
it to come up healthy. Open **http://localhost:8087** and the first-run wizard
takes it from there — admin account, optional public URL, embeddings, MFA.

| Install option | Effect |
| --- | --- |
| `--no-ollama` / `-NoOllama` | Skip bundled Ollama (using a host install? set `OLLAMA_URL` in `.env`) |
| `--no-search` / `-NoSearch` | Skip bundled SearXNG web search (add Brave/Tavily keys later in Admin) |
| `--minimal` / `-Minimal` | Both of the above |

The choice persists via `COMPOSE_PROFILES` in `.env`; re-run the script with a
different flag to change it. **NVIDIA GPU?** Swap the `ollama` token for `gpu`
in that line (needs the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)).

## Highlights

- **Every model** — Anthropic, OpenAI, Google, DeepSeek, 300+ via OpenRouter, local models via Ollama, any OpenAI-compatible endpoint
- **Parallel agents & deep research** — fan a question out to concurrent research agents; get one merged, cited brief
- **Workspaces** — chats, notes, canvas, boards and sheets sharing one retrieval layer
- **Voice** — self-hosted Whisper dictation and Kokoro read-aloud; hands-free voice mode
- **Automations** — node-graph flows on cron/webhook triggers with a credentials vault
- **Study** — an AI tutor with unit plans, interactive exercises and final exams
- **Multi-user & secure** — invite-only accounts, MFA, audit log, per-user quotas, admin analytics
- **Private by architecture** — zero telemetry; pair with local models and search for a fully offline stack

The full tour — live demos included — is at **[chatpromptly.com](https://chatpromptly.com)**.

## Updating

```bash
git pull && ./install.sh   # re-running is always safe; keeps your secrets and data
```

## Backup

Everything lives in `./data/` next to the compose file — Postgres, Redis,
Ollama models, uploads. Back up that folder and you have everything.

## License

[MIT](LICENSE)
