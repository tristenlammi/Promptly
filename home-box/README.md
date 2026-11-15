# Promptly Home box

A **home box** is a small computer in a home that runs Home Assistant (out of
sight) and the Promptly connector. The connector dials out to your Promptly
server, so nothing is opened on the home's router. People add the box to their
home in Promptly with the code on its card, then add and control their devices
from Promptly's Home page. They never see Home Assistant.

Start from a **fresh** Home Assistant: one nobody has opened or set up. The
connector sets it up by itself. Add the connector and nothing else.

There are two ways to run a box. Both begin the same way:

1. In Promptly, open **Admin → Home**, turn Promptly Home on, and press
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

- `connector/promptly_box.py`: the connector. Talks to Home Assistant on the
  box and to the Promptly server; turns Home Assistant's devices and set-up
  steps into the plain shapes Promptly shows.
- `compose/`: way A.
- `addon-repo/`: way B.

If a box is lost: Admin → Home → **Cut off**. If it was wiped and needs its
setup string again: **New setup**. If its card was lost before anyone claimed
it: **New card**.
