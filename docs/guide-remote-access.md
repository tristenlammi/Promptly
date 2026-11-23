# Reaching Promptly from outside your home

Promptly serves plain HTTP on port **8087** (and 8488). Your home network
can use it directly (browsers, Home Assistant, devices); the internet should
reach it only through a tunnel or a TLS proxy.

Back to the [README](../README.md).

## What should be reachable

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

## Check from outside

From a phone on mobile data, or any machine not on your network, check that
nothing answers except what you meant to open:

```bash
nmap -Pn -p 8087,8488,7880,6789,7881 <your public IPv4>       # expect: filtered/closed
nmap -6 -Pn -p 8087,8488,7880,6789,7881 <the server's IPv6>   # expect: filtered/closed
nmap -Pn -sU -p 7882 <your public IPv4>                       # open|filtered only if you use calls
```

(Find the server's IPv6 with `ip -6 addr show scope global` on it, and your
public IPv4 at a "what is my IP" page.) Online port checkers work too; check
both IPv4 and IPv6.

## Cloudflare Tunnel

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

## Your own nginx server block

If you terminate TLS yourself with a server block in `nginx/local/`, add
`include /etc/nginx/promptly/media.conf;` to it. That's what serves photos,
videos and downloads, and takes big uploads.

## Voice channels from outside

Voice channels in Rooms run on a self-hosted LiveKit server that the
installer sets up. Turn voice on in **Admin → Calls**. At home it works with
no router changes. For voice from outside, forward **UDP 7882** and **TCP
7881** on your router to the server (audio doesn't go through Cloudflare or
your web address), then run **Test calls** (Account → Voice & video) on a
phone with Wi-Fi off. The admin checklist says what's missing.

## Microphone on phones

Browsers only allow the microphone on `https://` (or `localhost`), so use
your public HTTPS address on phones for Talk, dictation and voice channels.
