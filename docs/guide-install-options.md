# Install options and local models

Back to the [README](../README.md).

## What the installer does

You need git and Docker with Compose 2.24 or newer, and curl for the one-line
install. On Linux, your user must be allowed to use Docker.

```bash
# Linux or macOS
curl -fsSL https://raw.githubusercontent.com/tristenlammi/Promptly/main/install.sh | bash

# with options
curl -fsSL https://raw.githubusercontent.com/tristenlammi/Promptly/main/install.sh | bash -s -- --with-home --no-maps
```

```powershell
# Windows PowerShell, with Docker Desktop running
irm https://raw.githubusercontent.com/tristenlammi/Promptly/main/install.ps1 | iex
```

The one-liner downloads the latest release into a `Promptly` folder where you
run it. If you'd rather clone the repository first, run `./install.sh`
(Windows: `.\install.ps1`) in it instead; options then go straight after the
script name.

The script creates all secrets, builds and starts everything, and waits for it
to come up healthy. Open **http://localhost:8087** and the setup wizard takes
it from there: you can set everything up now (about ten minutes) or just look
around and finish later from the "Finish setting up" list on Today and under
Admin → Setup.

Measured on a 4-core, 8 GB Linux test box: installing takes about 10 minutes
(longer on a slow connection) and an update 1 to 4 minutes. Idle memory is
about 5.1 GB by default and about 4.8 GB with every optional part off. Disk is
about 19 GB by default before any map data, and about 17 GB without Maps; 5 to
7 GB of that is build cache that `docker builder prune` gives back. Promptly
Home adds about 7 GB of disk and 0.6 GB of memory.

By default Promptly is **cloud-first**: connect your API keys (OpenAI,
Anthropic, OpenRouter, …) in the wizard. It does not bundle an Ollama
container. If you're already running Ollama natively on the host, the
installer detects it and wires the stack to it automatically.

## Options

| Install option | Effect |
| :-- | :-- |
| `--with-home` | Add Promptly Home: smart devices through a bundled Home Assistant and its connector (about 7 GB of disk, 0.6 GB of memory). Not installed unless you ask |
| `--with-ollama` | Bundle a local-model container. GPU auto-detected: NVIDIA (CUDA), AMD (ROCm), else CPU |
| `--no-search` | Skip the bundled SearXNG web search. Add Brave/Tavily keys later in Admin |
| `--no-maps` | Skip P Maps. It is on by default but downloads no map data until an admin chooses a country |
| `--no-calls` | Skip the calls service (LiveKit) behind voice channels in Rooms |
| `--no-start` | Set the folder up (`.env`, secrets, your choices) without building or starting, so you can change the port first |

PowerShell spelling: `-WithHome`, `-WithOllama`, `-NoSearch`, `-NoMaps`,
`-NoCalls`, `-NoStart`.

The choice persists in `COMPOSE_PROFILES` in `.env`.

## Promptly Home

Home is an add-on, so a new install doesn't have it. Add it at install time
with `--with-home`, or later by running the installer again in the Promptly
folder with just that option (`./install.sh --with-home`, Windows
`.\install.ps1 -WithHome`): it adds Home and leaves your other choices as they
are. Then turn it on in Admin → Home.

An install that already has Home keeps it across updates. An update never
adds it. To take it out, run the installer with `--no-home` together with the
other options you use, or remove the `home` (or `home-desktop`) word from
`COMPOSE_PROFILES` in `.env` and run `docker compose up -d --remove-orphans`.

## Local models

A **native** Ollama ([ollama.com](https://ollama.com)) is the best option on
every platform: better GPU support than the container, and the installer
wires it up for you. Use `--with-ollama` only when you'd rather Docker manage
it. On Linux that gives real GPU acceleration (NVIDIA via the
[Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html),
AMD via ROCm), while on macOS/Windows the container is CPU-only (Docker can't
reach the GPU there).

## P Maps

P Maps is on after an install but has no map yet. An admin chooses a country,
or several, in first-time setup or later under Admin → App settings → "Maps on
this server". The download size, the disk space it needs and roughly how long
it takes are shown before anything downloads, and a choice that doesn't fit on
the disk can't be started.

Some examples: New Zealand takes about 3 GB, Australia about 11 GB (with
18.5 GB free while it builds), Great Britain about 15 GB and Germany about
33 GB. Adding a country rebuilds the whole set; the maps you already have keep
working while that happens.

House-number search depends on how well OpenStreetMap covers your area.
Australia also gets the full official address file.

If you set `MAPS_PBF_URL`, `MAPS_PHOTON_URL` or `MAPS_BBOX` in `.env`, the map
is managed there and the in-app chooser is switched off.

## Voice channels

Voice channels (Rooms) run on a self-hosted LiveKit server that the installer
sets up. Turn voice on in **Admin → Calls**. See
[Reaching Promptly from outside](guide-remote-access.md#voice-channels-from-outside)
for the two ports voice needs when people join from outside your home.
