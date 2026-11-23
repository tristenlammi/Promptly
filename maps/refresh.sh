#!/bin/bash
# Downloads and builds the map data into a new folder, then swaps it in, so
# the running maps keep working the whole time. Safe to stop: a finished step
# is not repeated on the next run.
#
# Which maps: regions.py works out the plan from what an admin chose in
# Promptly (/data/regions.json), or from MAPS_PBF_URL / MAPS_PHOTON_URL /
# MAPS_BBOX in .env, which still win. With neither, nothing is downloaded.
# All the chosen maps go into ONE build (one set of routing tiles, one search
# index, one basemap), so routes cross borders; adding or removing a map
# builds the set again next to the live one.
#
# Only downloads happen here; nothing about anyone's searches or trips ever
# leaves the server.
set -euo pipefail

DATA=/data
BUILDS_URL=https://build-metadata.protomaps.dev/builds.json
TILES_URL=https://build.protomaps.com
MAX_AGE_DAYS=${MAPS_REFRESH_DAYS:-30}
THREADS=${MAPS_BUILD_THREADS:-4}
# Offline packs for phones (1-degree squares of map, routing and search), built
# with each refresh. MAPS_OFFLINE=0 leaves them out (saves about 5 GB a build).
OFFLINE=${MAPS_OFFLINE:-1}
[ "$OFFLINE" = 0 ] && offline_json=false || offline_json=true
# Languages search keeps names in, besides each place's local name.
LANGUAGES=${MAPS_SEARCH_LANGUAGES:-en}

PLAN="$DATA/plan.json"
STEPS="osm basemap routing search places"
BUILDING='[]'
status() {  # status STATE [STEP] [ERROR] [DETAIL]
  jq -n --arg state "$1" --arg step "${2:-}" --arg error "${3:-}" --arg detail "${4:-}" --arg at "$(date -u +%FT%TZ)" \
    --argjson offline "$offline_json" --argjson regions "$BUILDING" --arg steps "$STEPS" \
    '{state:$state, step:$step, error:$error, detail:$detail, at:$at, offline:$offline, regions:$regions, steps:($steps | split(" "))}' > "$DATA/status.tmp"
  mv -f "$DATA/status.tmp" "$DATA/status.json"
}
trap 'status failed "${STEP:-}" "Stopped at this step: see the Promptly-Maps log"' ERR

mkdir -p "$DATA"
python3 /opt/maps/regions.py plan > "$PLAN.tmp"
mv -f "$PLAN.tmp" "$PLAN"
SOURCE=$(jq -r .source "$PLAN")
SIGNATURE=$(jq -r .signature "$PLAN")
COUNT=$(jq '.regions | length' "$PLAN")
GNAF=$(jq -r .gnaf "$PLAN")
BUILDING=$(jq -c '[.regions[] | {id, name}]' "$PLAN")
[ "$GNAF" = true ] && STEPS="osm basemap routing addresses search places"
[ "$OFFLINE" != 0 ] && STEPS="$STEPS areas"

B="$DATA/next"
if [ "$COUNT" = 0 ]; then
  # No map chosen: wait. If the last one was taken away, its data goes too.
  if [ "$SOURCE" = chosen ] && [ -e "$DATA/current" ]; then
    rm -f "$DATA/current"
    sleep 25   # entry.sh stops routing and search first
  fi
  if [ "$SOURCE" = chosen ]; then rm -rf "$DATA"/build-* "$B"; fi
  if [ -f "$B/.signature" ]; then rm -rf "$B"; fi
  status none
  echo "maps: no map chosen yet; an admin picks one in Promptly (Admin > App settings)"
  exit 0
fi

current=$(cat "$DATA/current" 2>/dev/null || true)
if [ -n "$current" ] && [ -f "$DATA/$current/manifest.json" ]; then
  built=$(date -r "$DATA/$current/manifest.json" +%s)
  age=$(( ($(date +%s) - built) / 86400 ))
  live=$(jq -r '.signature // ""' "$DATA/$current/manifest.json")
  # A build from before maps were chosen has no list: it counts as the plan
  # when the plan is what it always was (Australia, or the map in .env).
  same=0
  if [ "$live" = "$SIGNATURE" ] || { [ -z "$live" ] && [ "$(jq -r .legacy_ok "$PLAN")" = true ]; }; then same=1; fi
  if [ "$same" = 1 ] && [ "$age" -lt "$MAX_AGE_DAYS" ]; then
    if [ -f "$B/.signature" ] && [ "$(cat "$B/.signature")" != "$SIGNATURE" ]; then rm -rf "$B"; fi
    status ready
    exit 0
  fi
fi

mkdir -p "$B/osm"
# A part-done build of a different set of maps: keep only the map files that
# are still wanted. (No .signature: a build started before maps were chosen.)
if [ -f "$B/.signature" ]; then
  if [ "$(cat "$B/.signature")" != "$SIGNATURE" ]; then
    echo "maps: the chosen maps changed; starting the build again"
    keep=$(jq -r '.regions[] | .slug + ".osm.pbf"' "$PLAN")
    for f in "$B"/* "$B"/.done-* "$B"/osm/*; do
      [ -e "$f" ] || continue
      [ "$f" = "$B/osm" ] && continue
      case "$f" in
        "$B"/osm/*) if echo "$keep" | grep -qxF "$(basename "$f")"; then continue; fi ;;
      esac
      rm -rf "$f"
    done
  fi
elif [ -f "$B/region.osm.pbf" ]; then
  mv "$B/region.osm.pbf" "$B/osm/$(jq -r '.regions[0].slug' "$PLAN").osm.pbf"
fi
echo "$SIGNATURE" > "$B/.signature"
PBFS=()
while IFS= read -r slug; do PBFS+=("$B/osm/$slug.osm.pbf"); done < <(jq -r '.regions[].slug' "$PLAN")
echo "maps: building $(jq -r '[.regions[].name] | join(", ")' "$PLAN")"

step() {  # step NAME: true if it still has to run
  STEP=$1
  [ -f "$B/.done-$1" ] && return 1
  status building "$1"
  echo "maps: $1"
  return 0
}
done_step() { touch "$B/.done-$1"; }

# The mirror swaps in each day's file over a few minutes, when "latest" can
# point at one that isn't there yet: wait and ask again before giving up.
fetch() {  # fetch URL FILE
  local try
  for try in 1 2 3 4 5 6 7 8; do
    if curl -fL --retry 5 -C - -o "$2" "$1"; then return 0; fi
    echo "maps: couldn't download $1 (try $try); trying again in 2 minutes" >&2
    sleep "${MAPS_RETRY_WAIT:-120}"
  done
  return 1
}

if step osm; then
  for i in $(seq 0 $((COUNT - 1))); do
    file="${PBFS[$i]}"
    [ -f "$file" ] && continue
    status building osm "" "$(jq -r ".regions[$i].name" "$PLAN")"
    fetch "$(jq -r ".regions[$i].pbf" "$PLAN")" "$file.part"
    mv "$file.part" "$file"
  done
  done_step osm
fi

if step basemap; then
  key=$(curl -fsSL "$BUILDS_URL" | jq -r 'map(.key) | sort | last')
  # The map in .env keeps its box; chosen maps are cut along their outlines.
  if [ "$SOURCE" = env ]; then
    area="--bbox=$(jq -r .bbox_arg "$PLAN")"
  else
    jq -c .area "$PLAN" > "$B/area.geojson"
    area="--region=$B/area.geojson"
  fi
  pmtiles extract "$TILES_URL/$key" "$B/basemap.part.pmtiles" "$area" --download-threads="$THREADS"
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
  rm -rf "$B/tiles"
  mkdir -p "$B/tiles"
  valhalla_build_admins -c "$B/valhalla.json" "${PBFS[@]}"
  valhalla_build_tiles -c "$B/valhalla.json" "${PBFS[@]}"
  valhalla_build_extract -c "$B/valhalla.json" -v --overwrite
  rm -rf "$B/tiles"
  done_step routing
fi

# Australia's real street addresses (G-NAF), when Australia is one of the maps.
# It comes out each quarter; a failed download means search uses OSM's
# addresses alone. Other countries have OSM's addresses.
if [ "$GNAF" = true ] && step addresses; then
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
  rm -rf "$B/photon_data" "$B/search.sqlite" "$B/search.sqlite.part" "$B/search.fifo"
  # Offline search reads the same stream Photon imports, through a FIFO. If it
  # fails, tee -p carries on and the build goes ahead without it.
  copy=/dev/null
  if [ "$OFFLINE" != 0 ]; then
    copy="$B/search.fifo"
    mkfifo "$copy"
    python3 /opt/maps/search_index.py build "$B/search.sqlite" < "$copy" &
    indexer=$!
  fi
  # regions.py streams each search file once, keeping only the chosen maps'
  # places (a small country can share a file with a big neighbour).
  if [ -f "$B/gnaf.zip" ]; then
    python3 /opt/maps/regions.py search "$PLAN" | python3 /opt/maps/addresses.py "$B/gnaf.zip" | tee -p "$copy" \
      | java -Xmx"${MAPS_IMPORT_HEAP:-2g}" -jar /opt/photon.jar import -data-dir "$B" -import-file - -languages "$LANGUAGES"
    echo "G-NAF" > "$B/addresses.source"
    rm -f "$B/gnaf.zip"
  else
    python3 /opt/maps/regions.py search "$PLAN" | tee -p "$copy" \
      | java -Xmx"${MAPS_IMPORT_HEAP:-2g}" -jar /opt/photon.jar import -data-dir "$B" -import-file - -languages "$LANGUAGES"
  fi
  if [ -n "${indexer:-}" ]; then
    wait "$indexer" || { echo "maps: offline search failed; offline packs go without it" >&2; rm -f "$B/search.sqlite"; }
    rm -f "$copy"
  fi
  done_step search
fi

if step places; then
  : > "$B/pois.geojsonseq"
  for file in "${PBFS[@]}"; do
    osmium tags-filter --overwrite -o "$B/pois.osm.pbf" "$file" \
      n/highway=speed_camera nwr/amenity=charging_station
    osmium export --overwrite -f geojsonseq -o "$B/pois.part.geojsonseq" "$B/pois.osm.pbf"
    cat "$B/pois.part.geojsonseq" >> "$B/pois.geojsonseq"
  done
  python3 /opt/maps/extract_pois.py "$B/pois.geojsonseq" "$B"
  rm -f "$B/pois.osm.pbf" "$B/pois.geojsonseq" "$B/pois.part.geojsonseq"
  done_step places
fi

# Offline packs: needs the map, the routing tiles, search.sqlite (from the
# search step) and the cameras. A failure here never holds back the new map.
if [ "$OFFLINE" != 0 ] && step areas; then
  rm -f "$B/areas.failed"
  if ! python3 /opt/maps/areas.py "$B" --threads "$THREADS"; then
    echo "maps: offline packs failed; the map carries on without them" >&2
    rm -rf "$B/areas.part"
    touch "$B/areas.failed"
  fi
  rm -f "$B/search.sqlite"
  done_step areas
fi

# Done: name it, swap it in, tidy up.
STEP=finish
osm_date=$(osmium fileinfo -g header.option.osmosis_replication_timestamp "${PBFS[0]}" 2>/dev/null || true)
rm -rf "$B/osm"
rm -f "$B"/.done-* "$B/.signature" "$B/area.geojson" "$B/search.sqlite" "$B/search.fifo"
name="build-$(date -u +%Y%m%d-%H%M%S)"
jq -n --arg built "$(date -u +%FT%TZ)" --arg osm "$osm_date" --arg basemap "$(cat "$B/basemap.source")" \
  --arg signature "$SIGNATURE" --argjson regions "$BUILDING" --argjson bounds "$(jq -c .bounds "$PLAN")" --argjson gnaf "$GNAF" \
  '{built_at:$built, osm_data:$osm, basemap:$basemap, signature:$signature, regions:$regions, bounds:$bounds, gnaf:$gnaf}' > "$B/manifest.json"
# The packs' index names the build it belongs to.
if [ -f "$B/areas/index.json" ]; then
  jq --arg build "$name" --arg built "$(jq -r .built_at "$B/manifest.json")" '.build=$build | .built_at=$built' \
    "$B/areas/index.json" > "$B/areas/index.tmp"
  mv -f "$B/areas/index.tmp" "$B/areas/index.json"
fi
# The config names the folder it was built in.
sed -i "s#$B/#$DATA/$name/#g" "$B/valhalla.json"
mv "$B" "$DATA/$name"
echo "$name" > "$DATA/current.tmp"
mv -f "$DATA/current.tmp" "$DATA/current"
sleep "${MAPS_SWAP_WAIT:-60}"   # let the services and open maps move over
for old in "$DATA"/build-*; do
  [ "$(basename "$old")" = "$name" ] || rm -rf "$old"
done
status ready
echo "maps: $name is live"
