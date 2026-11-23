# Photos, videos and big uploads

Back to the [README](../README.md).

## The media worker

Photos and videos are thumbnailed and, where a browser can't play them,
converted by the `media-worker` container. It is capped at `MEDIA_WORKER_CPUS`
(default 2) and `MEDIA_WORKER_MEM_LIMIT` (default 3g) so it never slows the
rest.

## Encoding video on a GPU

To encode video on a GPU, add one override (Linux; NVIDIA needs the
[Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)):

| Override file | For |
| :-- | :-- |
| `docker-compose.media-nvidia.yml` | NVIDIA |
| `docker-compose.media-vaapi.yml` | Intel / AMD (VAAPI) |
| `docker-compose.media-qsv.yml` | Intel Quick Sync |

For example, in `.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.media-nvidia.yml
```

Anything the GPU can't do falls back to the CPU.

## Big uploads

Uploads over 64 MB (a long phone video) go through the `tusd` service in
50 MB pieces, so they fit under Cloudflare's 100 MB request limit and resume
after a dropped connection or a refresh. The largest single upload is set in
Admin → App settings (10 GB by default).

## Your own nginx server block

If you use your own nginx server block (TLS in `nginx/local/`), add
`include /etc/nginx/promptly/media.conf;` to it. That's what serves photos,
videos and downloads, and takes big uploads.
