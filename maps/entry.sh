#!/bin/bash
# Runs the refresh loop, plus routing and search over whichever build
# /data/current names, and the control door Promptly's backend uses to choose
# maps (control.py). Nothing here is reachable from outside the Docker network.
set -u
DATA=/data
mkdir -p "$DATA"

# Changes when an admin picks different maps, or asks for another try.
stamp() { cat "$DATA/regions.json" "$DATA/.kick" 2>/dev/null | md5sum | cut -c1-32; }

control_loop() {
  while true; do
    python3 /opt/maps/control.py || echo "maps: the control door stopped; starting it again" >&2
    sleep 5
  done
}
control_loop &

refresh_loop() {
  # Map data from before maps were chosen becomes the choice here, once, so
  # writing it down doesn't look like a change of mind below.
  python3 /opt/maps/regions.py plan > /dev/null || true
  while true; do
    seen=$(stamp)
    # Its own process group, so a change of maps can stop a build mid-step.
    setsid /opt/maps/refresh.sh &
    job=$!
    while kill -0 "$job" 2>/dev/null; do
      sleep 5
      if [ "$(stamp)" != "$seen" ]; then
        echo "maps: the chosen maps changed; stopping this build"
        kill -TERM -- "-$job" 2>/dev/null || kill -TERM "$job" 2>/dev/null
        sleep 3
        kill -KILL -- "-$job" 2>/dev/null
        break
      fi
    done
    wait "$job" 2>/dev/null || echo "maps: refresh stopped or failed; the current data stays in use" >&2
    # Look again in 6 hours (refresh.sh does nothing until the data is old
    # enough), or as soon as the choice changes.
    end=$((SECONDS + 21600))
    while [ "$SECONDS" -lt "$end" ] && [ "$(stamp)" = "$seen" ]; do sleep 5; done
  done
}
refresh_loop &

while true; do
  build=$(cat "$DATA/current" 2>/dev/null || true)
  if [ -z "$build" ] || [ ! -f "$DATA/$build/manifest.json" ]; then
    sleep 5
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
    sleep 5
  done
  kill $v $p 2>/dev/null
  wait $v $p 2>/dev/null
  sleep 2
done
