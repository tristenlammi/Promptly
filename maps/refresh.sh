#!/bin/bash
# Downloads and builds the map data into a new folder, then swaps it in, so
# the running maps keep working the whole time. Safe to stop: a finished step
# is not repeated on the next run.
#
# Only downloads happen here; nothing about anyone's searches or trips ever
# leaves the server.
set -euo pipefail

DATA=/data
PBF_URL=${MAPS_PBF_URL:-https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf}
PHOTON_URL=${MAPS_PHOTON_URL:-https://download1.graphhopper.com/public/australia-oceania/australia/photon-dump-australia-1.0-latest.jsonl.zst}
BBOX=${MAPS_BBOX:-112,-44.5,154.5,-9}
BUILDS_URL=https://build-metadata.protomaps.dev/builds.json
TILES_URL=https://build.protomaps.com
MAX_AGE_DAYS=${MAPS_REFRESH_DAYS:-30}
THREADS=${MAPS_BUILD_THREADS:-4}

status() {
  jq -n --arg state "$1" --arg step "${2:-}" --arg error "${3:-}" --arg at "$(date -u +%FT%TZ)" \
    '{state:$state, step:$step, error:$error, at:$at}' > "$DATA/status.tmp"
  mv -f "$DATA/status.tmp" "$DATA/status.json"
}
trap 'status failed "${STEP:-}" "Stopped at this step: see the Promptly-Maps log"' ERR

current=$(cat "$DATA/current" 2>/dev/null || true)
if [ -n "$current" ] && [ -f "$DATA/$current/manifest.json" ]; then
  built=$(date -r "$DATA/$current/manifest.json" +%s)
  age=$(( ($(date +%s) - built) / 86400 ))
  if [ "$age" -lt "$MAX_AGE_DAYS" ]; then
    status ready
    exit 0
  fi
fi

B="$DATA/next"
mkdir -p "$B"
step() {  # step NAME: true if it still has to run
  STEP=$1
  [ -f "$B/.done-$1" ] && return 1
  status building "$1"
  echo "maps: $1"
  return 0
}
done_step() { touch "$B/.done-$1"; }

if step osm; then
  curl -fL --retry 5 -C - -o "$B/region.osm.pbf.part" "$PBF_URL"
  mv "$B/region.osm.pbf.part" "$B/region.osm.pbf"
  done_step osm
fi

if step basemap; then
  key=$(curl -fsSL "$BUILDS_URL" | jq -r 'map(.key) | sort | last')
  pmtiles extract "$TILES_URL/$key" "$B/basemap.part.pmtiles" --bbox="$BBOX" --download-threads="$THREADS"
  mv "$B/basemap.part.pmtiles" "$B/basemap.pmtiles"
  echo "$key" > "$B/basemap.source"
  done_step basemap
fi

if step routing; then
  valhalla_build_config \
    --mjolnir-tile-dir "$B/tiles" \
    --mjolnir-tile-extract "$B/valhalla_tiles.tar" \
    --mjolnir-admin "$B/admins.sqlite" \
    --mjolnir-concurrency "$THREADS" \
    > "$B/valhalla.json"
  mkdir -p "$B/tiles"
  valhalla_build_admins -c "$B/valhalla.json" "$B/region.osm.pbf"
  valhalla_build_tiles -c "$B/valhalla.json" "$B/region.osm.pbf"
  valhalla_build_extract -c "$B/valhalla.json" -v --overwrite
  rm -rf "$B/tiles"
  done_step routing
fi

# Australia's real street addresses (G-NAF), for the default region. It comes
# out each quarter; a failed download means search uses OSM's addresses alone.
if [ -z "${MAPS_PBF_URL:-}" ] && step addresses; then
  url=$(curl -fsSL "https://data.gov.au/data/api/3/action/package_show?id=geocoded-national-address-file-g-naf" \
    | jq -r '[.result.resources[] | select(.name | test("GDA2020")) | .url] | first' || true)
  if [ -n "$url" ] && [ "$url" != "null" ] && curl -fL --retry 20 --retry-all-errors --retry-delay 30 -C - -o "$B/gnaf.zip.part" "$url"; then
    mv "$B/gnaf.zip.part" "$B/gnaf.zip"
  else
    echo "maps: G-NAF download failed; carrying on without it" >&2
    # Admins see this: search works, but without house numbers.
    touch "$B/addresses.failed"
  fi
  done_step addresses
fi

if step search; then
  rm -rf "$B/photon_data"
  if [ -f "$B/gnaf.zip" ]; then
    curl -fsSL --retry 5 "$PHOTON_URL" | zstd -dc | python3 /opt/maps/addresses.py "$B/gnaf.zip" \
      | java -Xmx"${MAPS_IMPORT_HEAP:-2g}" -jar /opt/photon.jar import -data-dir "$B" -import-file - -languages en
    echo "G-NAF" > "$B/addresses.source"
    rm -f "$B/gnaf.zip"
  else
    curl -fsSL --retry 5 "$PHOTON_URL" | zstd -dc \
      | java -Xmx"${MAPS_IMPORT_HEAP:-2g}" -jar /opt/photon.jar import -data-dir "$B" -import-file - -languages en
  fi
  done_step search
fi

if step places; then
  osmium tags-filter --overwrite -o "$B/pois.osm.pbf" "$B/region.osm.pbf" \
    n/highway=speed_camera nwr/amenity=charging_station
  osmium export --overwrite -f geojsonseq -o "$B/pois.geojsonseq" "$B/pois.osm.pbf"
  python3 /opt/maps/extract_pois.py "$B/pois.geojsonseq" "$B"
  rm -f "$B/pois.osm.pbf" "$B/pois.geojsonseq"
  done_step places
fi

# Done: name it, swap it in, tidy up.
STEP=finish
osm_date=$(osmium fileinfo -g header.option.osmosis_replication_timestamp "$B/region.osm.pbf" 2>/dev/null || true)
rm -f "$B/region.osm.pbf" "$B"/.done-*
name="build-$(date -u +%Y%m%d-%H%M)"
jq -n --arg built "$(date -u +%FT%TZ)" --arg osm "$osm_date" --arg basemap "$(cat "$B/basemap.source")" \
  '{built_at:$built, osm_data:$osm, basemap:$basemap}' > "$B/manifest.json"
# The config names the folder it was built in.
sed -i "s#$B/#$DATA/$name/#g" "$B/valhalla.json"
mv "$B" "$DATA/$name"
echo "$name" > "$DATA/current.tmp"
mv -f "$DATA/current.tmp" "$DATA/current"
sleep 60   # let the services and open maps move over
for old in "$DATA"/build-*; do
  [ "$(basename "$old")" = "$name" ] || rm -rf "$old"
done
status ready
echo "maps: $name is live"
