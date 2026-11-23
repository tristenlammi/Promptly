# Talk: setting up and tuning spoken conversation

**Talk** is a live spoken conversation with Promptly: you talk, it answers out
loud, you can talk over it, and it can do things for you (add to your
calendar, set a timer) after a spoken yes. It's on the Talk button beside
Send, on Today, in Ctrl+K, and in the Android app's assistant. Speech is
recognised and spoken on your server by the `whisper` and `tts` containers,
which always start; only the text of what you say goes to the model. Audio is
never saved.

Back to the [README](../README.md).

## First start

The first start downloads the speech models into `data/whisper` (Whisper
`base`, ~140 MB, plus the Smart Turn end-of-turn model, ~8 MB) and `data/tts`
(Kokoro, ~330 MB). Browsers only allow the microphone on `https://` (or
`localhost`), so use your public HTTPS address on phones.

## Settings in `.env`

| `.env` setting | Default | What it does |
| :-- | :-- | :-- |
| `WHISPER_LIVE_MODEL` | `base` | The Whisper model Talk listens with. `tiny` is quicker and less accurate; `small` can't keep up live on a CPU. `off` turns live listening off: people get the simpler tap-to-talk voice mode instead. Dictation and meetings use `WHISPER_MODEL`. |
| `WHISPER_LIVE_SLOTS` | `2` | How many of Talk's transcription passes run at once (4 threads each). Others wait their turn. |
| `TTS_THREADS` | `4` | CPU threads Kokoro uses to speak. 4 is as fast as one per core on a quiet box and much faster on a busy one. |
| `TTS_STREAM_SLOTS` | `2` | How many answers are spoken at once. Others wait their turn. |
| `WHISPER_MEM_LIMIT` / `TTS_MEM_LIMIT` | `2g` | Memory caps for the two speech containers. |

After changing one, run `docker compose up -d whisper tts`.

## Settings in the admin panel

In **Admin → Talk** you can turn Talk off, limit it to some user groups, and
set how many people can talk at once (2 by default; each person talking uses
about one CPU core while they speak; above 8, also raise
`WHISPER_LIVE_MAX_SESSIONS`). It shows the speech models in use and how fast
answers have been: keep "First sound" low by picking a fast **voice model**
under Admin → Models → Defaults. Only timings are kept for that, for 30 days,
never words. If you pick a hosted voice model, the Talk screen says where the
answers come from.
