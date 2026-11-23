# Install options and local models

Back to the [README](../README.md).

## What the installer does

Any machine that runs Docker (Compose v2 ≥ 2.24) will do. The script
generates all secrets, builds and starts the stack, and waits for it to come
up healthy. Open **http://localhost:8087** and the first-run wizard takes it
from there.

By default Promptly is **cloud-first**: connect your API keys (OpenAI,
Anthropic, OpenRouter, …) in the wizard. It does not bundle an Ollama
container. If you're already running Ollama natively on the host, the
installer detects it and wires the stack to it automatically.

## Options

| Install option | Effect |
| :-- | :-- |
| `--with-ollama` | Bundle a local-model container. GPU auto-detected: NVIDIA (CUDA), AMD (ROCm), else CPU |
| `--no-search` | Skip the bundled SearXNG web search. Add Brave/Tavily keys later in Admin |
| `--no-maps` | Skip P Maps, which is on by default and builds its map data in the background (about an hour and 15 GB of disk, 7 GB after) |
| `--no-calls` | Skip the calls service (LiveKit) behind voice channels in Rooms |
| `--no-home` | Skip Promptly Home (the bundled Home Assistant and its connector) |

PowerShell spelling: `-WithOllama`, `-NoSearch`, `-NoMaps`, `-NoCalls`,
`-NoHome`.

The choice persists in `COMPOSE_PROFILES` in `.env`.

## Local models

A **native** Ollama ([ollama.com](https://ollama.com)) is the best option on
every platform: better GPU support than the container, and the installer
wires it up for you. Use `--with-ollama` only when you'd rather Docker manage
it. On Linux that gives real GPU acceleration (NVIDIA via the
[Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html),
AMD via ROCm), while on macOS/Windows the container is CPU-only (Docker can't
reach the GPU there).

## P Maps

<!-- FACTS: Maps is changing. A fresh install is to download no map data until the admin picks a country in setup, with more regions added later in the app. The text below describes v0.52.4 and should be replaced when that lands. -->

In v0.52.4, P Maps covers Australia out of the box. For another country, set
the `MAPS_*` values in `.env` (see "P Maps" there).

## Voice channels

Voice channels (Rooms) run on a self-hosted LiveKit server that the installer
sets up. Turn voice on in **Admin → Calls**. See
[Reaching Promptly from outside](guide-remote-access.md#voice-channels-from-outside)
for the two ports voice needs when people join from outside your home.
