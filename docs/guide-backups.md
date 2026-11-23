# Updating, backups and storage health

Back to the [README](../README.md).

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
`docker-compose.override.yml`. The update refuses to run over local edits
to tracked files, since they'd be overwritten.

## Automatic backups

Promptly dumps its database into `data/backups/` before every update and
every night at 02:00 (the last 14 are kept). Admin → Backups shows the last
good backup and has a *Back up now* button; every admin is alerted if one
fails. Deleted files stay on disk for 14 days before they're removed.

## A full backup

A full backup needs three things, and copying `./data` while Postgres is
running is not one of them (the database files can be mid-write):

1. the database, as a dump;
2. `data/uploads` (or wherever `PROMPTLY_UPLOADS_DIR` points) and `data/whiteboard`: your files;
3. **`.env`**: its `SECRET_KEY` decrypts every stored API key and secret.
   Lose it and a restored install can't use them.

One command bundles all three into a single archive:

```bash
./scripts/backup.sh                      # → data/backups/full/promptly-backup-<time>.tar
.\scripts\backup.ps1                     # Windows
```

It also picks up `nginx/ssl`, `nginx/local` and `docker-compose.override.yml`
if you have them, and `--with-env` puts them back. The off-site copies below
don't include those, so keep a full backup too if you rely on them.

Copy that archive to another machine or drive. A backup on the same disk
isn't a backup. Models, thumbnails, Redis and the search index are rebuilt
automatically and don't need backing up. After a restore, thumbnails come back
over the next while as the media worker remakes them, and the map data is
downloaded again.

## Restore

```bash
./scripts/restore.sh promptly-backup-<time>.tar               # same machine
./scripts/restore.sh promptly-backup-<time>.tar --with-env    # new machine: also restores .env
./scripts/restore.sh --db-only data/backups/nightly-<time>.dump   # just the database
```

(`.\scripts\restore.ps1` on Windows, with `-WithEnv` / `-DbOnly`.) The
database is dropped and recreated from the backup; your current files are
moved aside rather than deleted.

## Off-site backup

In Admin → Backups, choose somewhere other than this machine: a USB disk or
NAS folder (set `OFFSITE_BACKUP_DIR` in `.env`), an S3 or Backblaze B2 bucket,
another computer over SFTP, or a restic rest-server. Promptly sends it an
encrypted copy of the database, your files and its keys every night. It checks
part of the stored data every week and test-restores the database into a
scratch copy every month; the card goes amber when copies exist only on this
machine or the last one is more than two days old.

The copies are encrypted with a password Promptly generates. **Save the
recovery kit** right after setting it up and keep it away from this machine
(a password manager, or printed):

```bash
./scripts/recovery-kit.sh                # → promptly-recovery-kit.txt
.\scripts\recovery-kit.ps1               # Windows
```

It holds the repository location, its password, the target's credentials and
`SECRET_KEY`, with the restore steps. It's never shown in the web app.

## Storage health

Every night Promptly checks that each stored file is still there and the right
size, and re-reads a share of them against the fingerprint taken when they
were uploaded, so the whole library is covered over a few nights. A file
that's gone missing or changed alerts the admins, shows up in Admin → Storage,
and carries a "restore it from a backup" note. Files on disk that nothing
refers to are moved to `.quarantine/` inside the uploads folder, never deleted
on their own. Uploads pause while the disk has less than 5% or 10 GB free
(`DISK_MIN_FREE_PERCENT` / `DISK_MIN_FREE_GB`), and admins hear about it at
85% and 95% full. If one device sends more than 500 files or 5 GB to the trash
in ten minutes, the owner is told at once and can put back everything that
device deleted.

## Database checksums

New installs keep a checksum on every database page, so a disk quietly
corrupting data is noticed instead of copied into backups. An install from
before this can switch them on: offline, once, after a backup (a few minutes
per few GB):

```bash
./scripts/backup.sh
docker compose stop
docker compose run --rm --no-deps --user postgres --entrypoint pg_checksums postgres --enable --progress --pgdata /var/lib/postgresql/data
docker compose up -d
```

Admin → Storage shows whether they're on.
