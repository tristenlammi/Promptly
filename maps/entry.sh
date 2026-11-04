#!/bin/bash
# Runs the refresh loop, plus routing and search over whichever build
# /data/current names. Nothing here is reachable from outside the Docker network.
set -u
DATA=/data
mkdir -p "$DATA"

refresh_loop() {
  while true; do
    /opt/maps/refresh.sh || echo "maps: refresh failed; the current data stays in use" >&2
    sleep 21600   # look again in 6 hours; refresh.sh does nothing until the data is old enough
  done
}
refresh_loop &

while true; do
  build=$(cat "$DATA/current" 2>/dev/null || true)
  if [ -z "$build" ] || [ ! -f "$DATA/$build/manifest.json" ]; then
    sleep 20
    continue
  fi
  dir="$DATA/$build"
  echo "maps: serving $build"
  valhalla_service "$dir/valhalla.json" "${MAPS_ROUTE_THREADS:-2}" &
  v=$!
  java -Xms256m -Xmx"${MAPS_SEARCH_HEAP:-1g}" -jar /opt/photon.jar serve -data-dir "$dir" -listen-ip 0.0.0.0 -listen-port 2322 &
  p=$!
  # Until a new build is swapped in, or one of the two stops.
  while [ "$(cat "$DATA/current" 2>/dev/null)" = "$build" ] && kill -0 $v 2>/dev/null && kill -0 $p 2>/dev/null; do
    sleep 20
  done
  kill $v $p 2>/dev/null
  wait $v $p 2>/dev/null
  sleep 2
done
