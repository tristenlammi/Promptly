# P Maps: the map data and the two services that read it, all local.
#   - Valhalla: routing
#   - Photon:   search (address and place names)
#   - refresh.sh: downloads and builds the data, then swaps it in
# Versions are pinned, and bumped on purpose.
FROM ghcr.io/valhalla/valhalla:3.9.1

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-21-jre-headless osmium-tool zstd curl ca-certificates python3 jq \
    && rm -rf /var/lib/apt/lists/*

# pmtiles cuts one country out of the Protomaps world basemap.
COPY --from=protomaps/go-pmtiles:v1.31.2 /go-pmtiles /usr/local/bin/pmtiles

ADD --checksum=sha256:a89707c0045e4807b2a1180e132e68e108d998709f48b6c94b98a6e281f571a5 \
    https://github.com/komoot/photon/releases/download/1.3.0/photon-1.3.0.jar /opt/photon.jar

COPY entry.sh refresh.sh extract_pois.py addresses.py /opt/maps/
RUN sed -i 's/\r$//' /opt/maps/*.sh && chmod +x /opt/maps/*.sh

ENTRYPOINT ["/opt/maps/entry.sh"]
