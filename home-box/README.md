# Promptly Home

**Home Assistant is bundled with Promptly.** After a normal install or update
it is simply there: two containers (Home Assistant, out of sight, and
Promptly's connector to it) that start with the rest of Promptly and connect
by themselves. There is nothing to prepare and no code to type.

1. Update Promptly as usual (`./update.sh`, or `update.ps1` on Windows).
2. Promptly → **Admin → Home** → turn on **Promptly Home**.
3. Open **Home**. Your home is there. Tap **Add a device**.

You add the rest of your household under Home → settings → People. Nobody
outside a home sees its devices, admins included.

## What the update adds

- Two containers: `Promptly-Home` (Home Assistant, pinned to a version) and
  `Promptly-HomeConnector`. About **3.5 GB** of disk for the image, downloaded
  once, and roughly **half a gigabyte of memory** while running.
- A third container, `Promptly-HomeMusic` (Music Assistant, pinned to a
  version), for playing music by name: about **3.2 GB** more disk and
  **450 MB of memory**. See "Music by name" below.
- One line in `.env`: `HOME_BOX_SECRET`, which the connector proves itself to
  the backend with. Nobody needs to see it.
- A token in `COMPOSE_PROFILES`: `home` on Linux and Unraid, `home-desktop` on
  Docker Desktop (Windows, macOS). Take it out (and `docker compose up -d
  --remove-orphans`) to leave Home out; the update won't put it back.
- Its data in `./data/home` (what Home Assistant knows about your devices and
  bridges). The full backup (`scripts/backup.sh`) includes it, without history
  and logs. The nightly database backup doesn't: restore that alone and your
  devices need adding again.

## Nothing joins a home by itself

Home Assistant sets up some things it finds on the network without asking,
but only while it is still being set up itself (Chromecast speakers, Sonos,
WiZ and LIFX bulbs, WLED, Yeelight and more). In a home that meant speakers
on the Home page that nobody had added.

So the bundled Home Assistant starts **without** looking for devices. The
connector gives it its account within seconds, then restarts it once, and
from then on it looks, and anything it finds waits under **Add a device →
Found on your network** until someone taps it. The first start therefore
takes about half a minute longer.

As a backstop the connector also takes out any set-up that came from the
network without anyone finishing a step for it (it goes back to "Found on
your network"), and the Home page says so once.

## Linux and Unraid: what is reachable on your network

Home Assistant shares the server's network (`network_mode: host`), because
devices announce themselves by broadcast and that doesn't reach Docker's
private network. With that:

- **Its own web screens listen on 127.0.0.1 only** (port 8123, or
  `HOME_HA_PORT` in `.env` if 8123 is taken; the update picks a free one). No
  other computer on your network can open them.
- If Home Assistant can't use that port (something else has it), it falls back
  to its own defaults: **every address, port 8123**. The update checks for
  this when it first turns Home on, and the connector's log says so loudly if
  it ever happens (`docker compose logs home-connector`): set `HOME_HA_PORT`
  to a free port and restart the two containers.
- It listens for device announcements on UDP 5353 (mDNS) and 1900 (SSDP), and
  uses whatever ports a brand you add needs.
- The connector shares the server's network too. It talks to Home Assistant on
  127.0.0.1 and to Promptly through Promptly's own port on this machine.

**Unraid:** if "Host access to custom networks" is on and Home never finds
devices, Home Assistant may be listening on the wrong interface. This hasn't
been tried on Unraid yet; tell us what you see.

## Docker Desktop (Windows, macOS)

Both containers sit on Promptly's private network and publish no port.
Docker Desktop can't share the computer's network, so **"Found on your
network" stays empty**: add devices with **Add by brand** and type the
device's or bridge's address. Brands that are happy with an address should
work (Philips Hue, TP-Link Kasa and Tapo, Shelly, LIFX, WiZ, ESPHome); ones
that rely on finding the device or being called back (Google Cast, Sonos)
won't work well. None of these has been tried with real hardware yet.

## Music by name

"Play Miles Davis in the lounge." Home Assistant can pause, skip and change
the volume of a speaker, but it can't start an artist or an album from a
streaming service. Music Assistant can, so it runs next to Home Assistant,
just as out of sight: the connector sets it up, and nobody opens its screens.

1. The home's owner opens **Home → settings → Music → Link Tidal**.
2. The page shows a short code and a button to **link.tidal.com**, Tidal's own
   site. Sign in to Tidal there and approve. No password is typed into
   Promptly, and what Tidal hands back is kept in `./data/home/music` on this
   server only.
3. Ask the assistant for music, typed or spoken.

What to know:

- **Only the home's own speakers.** Music Assistant would normally look for
  every AirPlay, Chromecast and DLNA speaker on the network. The connector
  takes those away and gives it only the kinds of speaker the home has added
  (a WiiM: its WiiM support), and it can only play to speakers that are in the
  home. Music lists which ones under "Plays on".
- **Ports.** On Linux and Unraid it shares the server's network: its web page
  is on port **8095** and the music itself on **8097**, both reachable from
  your home network (speakers fetch the music from 8097). The page is behind a
  sign-in only the connector has. Both ports must be free.
- **Docker Desktop (Windows, macOS):** linking and searching work, but nothing
  plays: a speaker can't fetch music from inside Docker Desktop.
- **Leaving it out:** put `HOME_MUSIC_URL=` (empty) in `.env`, then
  `docker compose up -d` and `docker compose stop home-music`.
- **Its version is pinned** like Home Assistant's, for the same reason: the
  connector sets a fresh one up through its API. Bump the tag in
  `docker-compose.yml` (both variants, and `home-box/compose`) on purpose and
  try it on a private copy first.
- Only Tidal can be linked so far.

## Changing the Home Assistant version

The image tag is pinned in `docker-compose.yml` (both `home-assistant` and
`home-assistant-desktop`). The connector sets a fresh Home Assistant up
through the calls its own first-run screens make, which aren't a promised
interface, so bump the tag on purpose and try it on a private copy first:

```bash
scripts/stack.sh up hometest --with home
```

## If it doesn't come up

- Admin → Home says "This server's home box is starting" for more than ten
  minutes: `docker compose ps` should show the two Home containers running;
  `docker compose logs home-connector` (or `home-connector-desktop`) says what
  it's waiting for.
- "This Home Assistant is already set up and the box has no token for it":
  `./data/home/box` was deleted but `./data/home/ha` wasn't. Stop the two
  containers, delete `./data/home`, start them again. Devices need adding
  again.

---

# Other homes (advanced): a separate home box

Everything below is for a home that isn't where the server is: a small
computer in that home runs a fresh Home Assistant and the same connector, and
dials out to your Promptly server. It's parked, not the main path: the code
works and is tested, and its controls are under **Admin → Home → Other homes
(advanced)**.

A **home box** is a small computer in a home that runs Home Assistant (out of
sight) and the Promptly connector. The connector dials out to your Promptly
server, so nothing is opened on the home's router. People add the box to their
home in Promptly with the code on its card (Home → settings → "Have a separate
home box with a code?").

Start from a **fresh** Home Assistant: one nobody has opened or set up. The
connector sets it up by itself. Add the connector and nothing else.

There are two ways to run a box. Both begin the same way:

1. In Promptly, open **Admin → Home → Other homes (advanced)** and press
   **Prepare a box**. You get a **setup string** (for the box) and a **card**
   (a code and a QR, for whoever will use the box). Both are shown once.

## A. With Docker, on any computer (the quick way to try it)

You need Docker (Docker Desktop on Windows or macOS, or Docker on Linux).

1. Open a terminal in this repository's `home-box/compose` folder.
2. Save the setup string and start the box. Admin → Home shows these commands
   with your setup string already filled in.

   Windows (PowerShell):

   ```powershell
   Set-Content .env "PROMPTLY_SETUP=pbox1.…"
   docker compose up -d --build
   ```

   macOS or Linux:

   ```bash
   echo "PROMPTLY_SETUP=pbox1.…" > .env
   docker compose up -d --build
   ```

   On Linux, use both files so Home Assistant can find devices by itself:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.linux.yml up -d --build
   ```

3. In about a minute, Admin → Home shows the box as **Waiting to be claimed ·
   online**. That means it reached your server and nobody has added it to a
   home yet.
4. In Promptly, open **Home → Add a home box** and type the code from the card
   (or scan the card's QR with a phone).

A Promptly on the same computer (`http://localhost:8091`) works as it is: the
connector reaches "localhost" through the host. A real address
(`https://promptly.example.org`) works too.

Useful:

```bash
docker compose logs -f connector     # what the box is doing
docker compose down                  # stop it (keeps its data)
docker compose down -v               # stop it and wipe it: a fresh box again
```

After `down -v` the setup string still works; the box comes back as the same
box, with an empty Home Assistant.

### What works in Docker on Windows or macOS, and what doesn't

Docker Desktop runs containers behind its own private network. Home Assistant
in there can **reach** devices on your home network, but it can't **hear**
them announce themselves, so:

- **"Found on your network" stays empty.** Add devices with **Add by brand**
  and type the device's or bridge's address (its IP, from your router's list
  of devices or the maker's app).
- Brands that are happy with an address should work: Philips Hue (the
  bridge's address, then press its button), TP-Link Kasa and Tapo, Shelly,
  LIFX, WiZ, ESPHome. None of these has been tried with real hardware yet.
- Brands that rely on finding the device, or on the device calling back,
  won't work well: Google Cast, Sonos.
- Tuya's sign-in shows a QR code to scan in its phone app, which Promptly
  doesn't draw yet.
- Matter needs more than this (a Matter server and a network the box is
  really on).

On Linux with `docker-compose.linux.yml`, and on a real box (below), Home
Assistant is on the home network itself and finds devices by itself.

## B. On Home Assistant OS (a Home Assistant Green, a Raspberry Pi, a mini PC)

This is the kind of box to hand to someone. The connector is a Home Assistant
add-on; here it's installed as a **local** add-on, straight from this folder,
with nothing published anywhere.

1. Start with a fresh Home Assistant OS. Plug the box into power and your
   router, wait a few minutes, and open `http://homeassistant.local:8123`.
   Create the first account when it asks (this is the one time you see Home
   Assistant's own screens).
2. On your computer, in `home-box/addon-repo`, run `sh package.sh`. It copies
   the connector into the `promptly_box` folder.
3. Copy the `promptly_box` folder into the box's `addons` folder. The easiest
   way: in Home Assistant, install the **Samba share** add-on (Settings →
   Add-ons → Add-on store), start it, then open `\\homeassistant.local\addons`
   from your computer and copy the folder in.
4. In Home Assistant: Settings → Add-ons → Add-on store → ⋮ (top right) →
   **Check for updates**. "Promptly Home" appears under **Local add-ons**.
   Install it.
5. Open its **Configuration** tab, paste the setup string into **setup**, save,
   and press **Start**. Turn on "Start on boot".
6. Admin → Home shows the box as **Waiting to be claimed · online**. Print the
   card and give it with the box.

Whoever gets the box plugs it into power and their router, scans the card and
taps **Add this box**.

This path has not been run on real hardware yet.

## What the pieces are

- `ha_config.py`: writes the bundled Home Assistant's configuration (where it listens) on every start.
- `connector/promptly_box.py`: the connector. Talks to Home Assistant on the
  box and to the Promptly server; turns Home Assistant's devices and set-up
  steps into the plain shapes Promptly shows.
- `compose/`: way A.
- `addon-repo/`: way B.

If a box is lost: Admin → Home → **Cut off**. If it was wiped and needs its
setup string again: **New setup**. If its card was lost before anyone claimed
it: **New card**.
