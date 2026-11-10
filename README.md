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

One command. Any machine that runs Docker (Compose v2 ≥ 2.24).

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
| `--no-maps` | Skip P Maps, which is on by default and builds its map data in the background (about an hour and 15 GB of disk, 7 GB after) |
| `--no-calls` | Skip the calls service (LiveKit) behind voice channels in Rooms |

PowerShell spelling: `-WithOllama`, `-NoSearch`, `-NoMaps`, `-NoCalls`.

**Voice channels** (Rooms) run on a self-hosted LiveKit server that the
installer sets up. Turn voice on in **Admin → Calls**. At home it works with
no router changes; for voice from outside, forward **UDP 7882** and **TCP
7881** on your router to the server (audio doesn't go through Cloudflare or
your web address), then run **Test calls** (Account → Voice & video) on a
phone with Wi-Fi off. The admin checklist says what's missing.

**P Maps** covers Australia out of the box. For another country, set the
`MAPS_*` values in `.env` (see "P Maps" there).

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

## Exposure: what should be reachable

Promptly serves plain HTTP on port **8087** (and 8488). Your home network
can use it directly (browsers, Home Assistant, devices); the internet should
reach it only through a tunnel or a TLS proxy.

- **Never port-forward 8087 or 8488 on your router.** Use Cloudflare Tunnel
  (below) or a TLS reverse proxy for access from outside.
- **Block inbound IPv6** to the server on your router (or the host firewall,
  e.g. `ufw default deny incoming` plus `ufw allow from 192.168.0.0/16`).
  Many routers let IPv6 straight through to every device, port-forward or
  not. Promptly publishes its ports on IPv4 only, but other services on the
  host may not.
- **Optional: `NGINX_BIND`** in `.env` opens the ports on one address only.
  The usual choice is the server's LAN address (`NGINX_BIND=192.168.1.20`):
  the LAN keeps working and the machine's other interfaces (a VPN, a second
  network) don't get it. Use `NGINX_BIND=127.0.0.1` only when cloudflared runs
  on the host itself and nothing on your LAN needs Promptly.
- **Calls** (Linux, host networking): LiveKit's signalling port **7880** and
  metrics port **6789** listen on every interface (nginx and the backend
  reach them from Docker's bridge, so they can't be limited to localhost).
  Don't forward them, and firewall them from the LAN if you can
  (`ufw deny 7880/tcp`, `ufw deny 6789/tcp`, after allowing Docker's bridge:
  `ufw allow from 172.16.0.0/12 to any port 7880,6789 proto tcp`). Only
  **7881/tcp** and **7882/udp** are meant to be reachable from outside.

**Check from outside** (a phone on mobile data, or any machine not on your
network) that nothing answers except what you meant to open:

```bash
nmap -Pn -p 8087,8488,7880,6789,7881 <your public IPv4>       # expect: filtered/closed
nmap -6 -Pn -p 8087,8488,7880,6789,7881 <the server's IPv6>   # expect: filtered/closed
nmap -Pn -sU -p 7882 <your public IPv4>                       # open|filtered only if you use calls
```

(Find the server's IPv6 with `ip -6 addr show scope global` on it, and your
public IPv4 at a "what is my IP" page.) Online port checkers work too; check
both IPv4 and IPv6.

### Cloudflare Tunnel

Run cloudflared as a container on Promptly's own network, pointed at nginx,
with no published ports. In `docker-compose.override.yml`:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest   # or pin a release tag
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
    restart: unless-stopped
    networks: [promptly]
```

and in the Cloudflare dashboard point the tunnel's public hostname at
`http://nginx:80`. nginx trusts the visitor address cloudflared sends
(`CF-Connecting-IP`) only from containers on that network, never from
Docker's gateway, so a device on your LAN can't pretend to be someone else.
cloudflared running on the host instead arrives through that gateway: it
works, but every visitor then looks like one address to the rate limits.

**One tunnel for several services** (cloudflared on the host, or a container
with host networking, pointed at `http://<server>:8087`): set
`TUNNEL_ON_HOST=1` in `.env` and restart nginx (`docker compose up -d nginx`).
nginx then trusts the visitor address from the gateway too. On a Linux server
that's safe: devices on your LAN reach the port with their own address, so
only programs on the server itself come through the gateway. Don't set it on
Docker Desktop (Windows or Mac), where every LAN connection comes through the
gateway.

## Talking to Promptly

**Talk** is a live spoken conversation with Promptly: you talk, it answers out
loud, you can talk over it, and it can do things for you (add to your
calendar, set a timer) after a spoken yes. It's on the Talk button beside
Send, on Today, in Ctrl+K, and in the Android app's assistant. Speech is
recognised and spoken on your server by the `whisper` and `tts` containers,
which always start; only the text of what you say goes to the model. Audio is
never saved.

The first start downloads the speech models into `data/whisper` (Whisper
`base`, ~140 MB, plus the Smart Turn end-of-turn model, ~8 MB) and `data/tts`
(Kokoro, ~330 MB). Browsers only allow the microphone on `https://` (or
`localhost`), so use your public HTTPS address on phones.

| `.env` setting | Default | What it does |
| :-- | :-- | :-- |
| `WHISPER_LIVE_MODEL` | `base` | The Whisper model Talk listens with. `tiny` is quicker and less accurate; `small` can't keep up live on a CPU. `off` turns live listening off: people get the simpler tap-to-talk voice mode instead. Dictation and meetings use `WHISPER_MODEL`. |
| `WHISPER_LIVE_SLOTS` | `2` | How many of Talk's transcription passes run at once (4 threads each). Others wait their turn. |
| `TTS_THREADS` | `4` | CPU threads Kokoro uses to speak. 4 is as fast as one per core on a quiet box and much faster on a busy one. |
| `TTS_STREAM_SLOTS` | `2` | How many answers are spoken at once. Others wait their turn. |
| `WHISPER_MEM_LIMIT` / `TTS_MEM_LIMIT` | `2g` | Memory caps for the two speech containers. |

After changing one, run `docker compose up -d whisper tts`.

In **Admin → Talk** you can turn Talk off, limit it to some user groups, and
set how many people can talk at once (2 by default; each person talking uses
about one CPU core while they speak; above 8, also raise
`WHISPER_LIVE_MAX_SESSIONS`). It shows the speech models in use and how fast
answers have been: keep "First sound" low by picking a fast **voice model**
under Admin → Models → Defaults. Only timings are kept for that, for 30 days,
never words. If you pick a hosted voice model, the Talk screen says where the
answers come from.

## Highlights

- **Every model** — Anthropic, OpenAI, Google, DeepSeek, 300+ via OpenRouter, local models via Ollama, any OpenAI-compatible endpoint
- **Parallel agents & deep research** — fan a question out to concurrent research agents; get one merged, cited brief
- **Workspaces** — chats, notes, canvas, boards and sheets sharing one retrieval layer
- **Talk** — a live spoken conversation you can interrupt, on the web and Android; self-hosted Whisper and Kokoro, plus dictation and read-aloud
- **Automations** — node-graph flows on cron/webhook triggers with a credentials vault
- **Multi-user & secure** — invite-only accounts, MFA, audit log, per-user quotas, admin analytics
- **Private by architecture** — zero telemetry; pair with local models and search for a fully offline stack

The full tour — live demos included — is at **[chatpromptly.com](https://chatpromptly.com)**.

## What the server admin can and can't see

Every account sees the same statement under Account → Privacy & activity:

> In Promptly, your admin manages accounts, storage and the server. The app
> never shows them your chats, mail, files, photos, notes, tasks, calendar,
> health, location, messages or voice. They see your account, sign-ins, how
> much space and AI you use, and errors without their contents. They see
> shared things only if they're in them, like anyone else.
>
> Two honest limits: anyone who runs the machine itself (shell or database
> access) can read what isn't end-to-end encrypted. Only Passwords is. And AI
> features send what you ask to the AI services your admin set up. Each model
> shows whether it's local or hosted.
>
> If your admin resets your password or changes your email, you'll be told,
> and it shows under Recent activity.

If you run a server for other people, that's the promise you're making. The
app keeps it: admin screens show counts and account details, never content,
and logs carry route templates, not addresses or anything typed. Docker's own
stdout logs on the host may still hold raw request lines from before v0.34.0.

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

It also picks up `nginx/ssl`, `nginx/local` and `docker-compose.override.yml`
if you have them, and `--with-env` puts them back. The off-site copies below
don't include those, so keep a full backup too if you rely on them.

Copy that archive to another machine or drive — a backup on the same disk
isn't a backup. Models, thumbnails, Redis and the search index are rebuilt
automatically and don't need backing up. After a restore, thumbnails come back
over the next while as the media worker remakes them, and the map data is
downloaded again.

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
