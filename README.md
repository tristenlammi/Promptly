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

By default Promptly is **cloud-first**: connect your API keys (OpenAI,
Anthropic, OpenRouter, …) in the wizard. It does not bundle an Ollama
container — but if you're already running Ollama natively on the host, the
installer detects it and wires the stack to it automatically.

| Install option | Effect |
| :-- | :-- |
| `--with-ollama` | Bundle a local-model container. GPU auto-detected: NVIDIA (CUDA), AMD (ROCm), else CPU |
| `--no-search` | Skip the bundled SearXNG web search — add Brave/Tavily keys later in Admin |

PowerShell spelling: `-WithOllama`, `-NoSearch`.

**Want local models?** A **native** Ollama ([ollama.com](https://ollama.com))
is the best option on every platform — better GPU support than the container,
and the installer auto-wires it. Use `--with-ollama` only when you'd rather
Docker manage it; on Linux that gives real GPU acceleration (NVIDIA via the
[Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html),
AMD via ROCm), while on macOS/Windows the container is CPU-only (Docker can't
reach the GPU there). The choice persists in `COMPOSE_PROFILES` in `.env`.

**Photos and videos** are thumbnailed and, where a browser can't play them,
converted by the `media-worker` container — capped at `MEDIA_WORKER_CPUS`
(default 2) and `MEDIA_WORKER_MEM_LIMIT` (default 3g) so it never slows the
rest. To encode video on a GPU, add one override (Linux; NVIDIA needs the
Container Toolkit): `docker-compose.media-nvidia.yml`,
`docker-compose.media-vaapi.yml` (Intel/AMD) or `docker-compose.media-qsv.yml`
(Intel Quick Sync), e.g.
`COMPOSE_FILE=docker-compose.yml:docker-compose.media-nvidia.yml` in `.env`.
Anything the GPU can't do falls back to the CPU.

**Big uploads** (over 64 MB — a long phone video) go through the `tusd`
service in 50 MB pieces, so they fit under Cloudflare's 100 MB request limit
and resume after a dropped connection or a refresh. The largest single upload
is set in Admin → App settings (10 GB by default).

**Your own nginx server block** (TLS in `nginx/local/`)? Add
`include /etc/nginx/promptly/media.conf;` to it — that's what serves photos,
videos and downloads, and takes big uploads.

## Highlights

- **Every model** — Anthropic, OpenAI, Google, DeepSeek, 300+ via OpenRouter, local models via Ollama, any OpenAI-compatible endpoint
- **Parallel agents & deep research** — fan a question out to concurrent research agents; get one merged, cited brief
- **Workspaces** — chats, notes, canvas, boards and sheets sharing one retrieval layer
- **Voice** — self-hosted Whisper dictation and Kokoro read-aloud; hands-free voice mode
- **Automations** — node-graph flows on cron/webhook triggers with a credentials vault
- **Multi-user & secure** — invite-only accounts, MFA, audit log, per-user quotas, admin analytics
- **Private by architecture** — zero telemetry; pair with local models and search for a fully offline stack

The full tour — live demos included — is at **[chatpromptly.com](https://chatpromptly.com)**.

## Updating

```bash
./update.sh                 # Linux/macOS: update to the latest release
.\update.ps1                # Windows
```

The update script backs up the database first (and stops if it can't),
shows which database changes are coming, rebuilds, restarts and checks that
everything came back. If something goes wrong:

```bash
./update.sh --rollback      # restore the pre-update database and code
```

`--version v0.9.0` moves to a specific release; `--channel main` follows the
main branch instead of releases. Keep your own settings in `.env` or a
`docker-compose.override.yml` — the update refuses to run over local edits
to tracked files, since they'd be overwritten.

## Backups

**Automatic.** Promptly dumps its database into `data/backups/` before every
update and every night at 02:00 (the last 14 are kept). Admin → Backups shows
the last good backup and has a *Back up now* button; every admin is alerted if
one fails. Deleted files stay on disk for 14 days before they're removed.

**A full backup** needs three things, and copying `./data` while Postgres is
running is not one of them (the database files can be mid-write):

1. the database, as a dump;
2. `data/uploads` (or wherever `PROMPTLY_UPLOADS_DIR` points) and `data/whiteboard` — your files;
3. **`.env`** — its `SECRET_KEY` decrypts every stored API key and secret.
   Lose it and a restored install can't use them.

One command bundles all three into a single archive:

```bash
./scripts/backup.sh                      # → data/backups/full/promptly-backup-<time>.tar
.\scripts\backup.ps1                     # Windows
```

Copy that archive to another machine or drive — a backup on the same disk
isn't a backup. Models, thumbnails, Redis and the search index are rebuilt
automatically and don't need backing up.

**Restore:**

```bash
./scripts/restore.sh promptly-backup-<time>.tar               # same machine
./scripts/restore.sh promptly-backup-<time>.tar --with-env    # new machine: also restores .env
./scripts/restore.sh --db-only data/backups/nightly-<time>.dump   # just the database
```

(`.\scripts\restore.ps1` on Windows, with `-WithEnv` / `-DbOnly`.) The
database is dropped and recreated from the backup; your current files are
moved aside rather than deleted.

**Off-site backup.** In Admin → Backups, choose somewhere other than this
machine — a USB disk or NAS folder (set `OFFSITE_BACKUP_DIR` in `.env`), an
S3 or Backblaze B2 bucket, another computer over SFTP, or a restic
rest-server — and Promptly sends it an encrypted copy of the database, your
files and its keys every night. It checks part of the stored data every
week and test-restores the database into a scratch copy every month; the
card goes amber when copies exist only on this machine or the last one is
more than two days old.

The copies are encrypted with a password Promptly generates. **Save the
recovery kit** right after setting it up and keep it away from this machine
(a password manager, or printed):

```bash
./scripts/recovery-kit.sh                # → promptly-recovery-kit.txt
.\scripts\recovery-kit.ps1               # Windows
```

It holds the repository location, its password, the target's credentials and
`SECRET_KEY`, with the restore steps. It's never shown in the web app.

**Storage health.** Every night Promptly checks that each stored file is still
there and the right size, and re-reads a share of them against the
fingerprint taken when they were uploaded, so the whole library is covered
over a few nights. A file that's gone missing or changed alerts the admins,
shows up in Admin → Storage, and carries a "restore it from a backup" note.
Files on disk that nothing refers to are moved to `.quarantine/` inside the
uploads folder, never deleted on their own. Uploads pause while the disk has
less than 5% or 10 GB free (`DISK_MIN_FREE_PERCENT` / `DISK_MIN_FREE_GB`),
and admins hear about it at 85% and 95% full. If one device sends more than
500 files or 5 GB to the trash in ten minutes, the owner is told at once and
can put back everything that device deleted.

**Database checksums.** New installs keep a checksum on every database page,
so a disk quietly corrupting data is noticed instead of copied into backups.
An install from before this can switch them on — offline, once, after a
backup (a few minutes per few GB):

```bash
./scripts/backup.sh
docker compose stop
docker compose run --rm --no-deps --user postgres --entrypoint pg_checksums postgres --enable --progress --pgdata /var/lib/postgresql/data
docker compose up -d
```

Admin → Storage shows whether they're on.

## License

[MIT](LICENSE)
