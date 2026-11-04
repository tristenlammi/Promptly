"""Makes Photon's import stream, with Australia's real street addresses.

OpenStreetMap is missing many Australian house numbers. The government's G-NAF
file has them all, so OSM's bare addresses are dropped and G-NAF's used instead.
Named places (shops, parks, a building with an address) stay from OSM.

    zstd -dc photon-dump.jsonl.zst | addresses.py gnaf.zip | java -jar photon.jar import -import-file -

G-NAF: © Geoscape Australia, licensed by the Commonwealth of Australia under the
Open G-NAF End User Licence Agreement. It may not be used for addressing mail.
"""
import csv
import io
import json
import re
import sys
import zipfile

STATES = {
    "ACT": "Australian Capital Territory",
    "NSW": "New South Wales",
    "NT": "Northern Territory",
    "OT": "Other Territories",
    "QLD": "Queensland",
    "SA": "South Australia",
    "TAS": "Tasmania",
    "VIC": "Victoria",
    "WA": "Western Australia",
}
SUFFIX = {"N": "North", "S": "South", "E": "East", "W": "West", "NE": "North East", "NW": "North West", "SE": "South East", "SW": "South West", "EX": "Extension", "LR": "Lower", "UP": "Upper", "CN": "Central"}


def nice(text):
    """"O'CONNELL ST" -> "O'Connell St"; "MCDONALD" -> "McDonald"."""
    out = text.title().replace("’S ", "’s ")
    out = re.sub(r"'S\b", "'s", out)
    return re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(), out)


def rows(archive, name):
    with archive.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8", newline=""), delimiter="|")


def number(a):
    first = f"{a['NUMBER_FIRST_PREFIX']}{a['NUMBER_FIRST']}{a['NUMBER_FIRST_SUFFIX']}"
    last = f"{a['NUMBER_LAST_PREFIX']}{a['NUMBER_LAST']}{a['NUMBER_LAST_SUFFIX']}"
    return f"{first}-{last}" if a["NUMBER_LAST"] else first


def state_places(archive, names, state, out):
    def member(table):
        ending = f"/{state}_{table}_psv.psv"
        return next(n for n in names if n.endswith(ending) and "/Standard/" in n)

    localities = {r["LOCALITY_PID"]: nice(r["LOCALITY_NAME"]) for r in rows(archive, member("LOCALITY"))}
    streets = {}
    for r in rows(archive, member("STREET_LOCALITY")):
        parts = [nice(r["STREET_NAME"]), nice(r["STREET_TYPE_CODE"]) if r["STREET_TYPE_CODE"] else "", SUFFIX.get(r["STREET_SUFFIX_CODE"], "")]
        streets[r["STREET_LOCALITY_PID"]] = " ".join(p for p in parts if p)

    # One entry per street number: a block of 50 units is one place to drive to.
    wanted = {}
    seen = set()
    for a in rows(archive, member("ADDRESS_DETAIL")):
        if a.get("DATE_RETIRED") or a.get("ALIAS_PRINCIPAL") != "P" or not a["NUMBER_FIRST"]:
            continue
        street = streets.get(a["STREET_LOCALITY_PID"])
        if not street:
            continue
        num = number(a)
        key = (a["STREET_LOCALITY_PID"], num)
        if key in seen:
            continue
        seen.add(key)
        wanted[a["ADDRESS_DETAIL_PID"]] = (num, street, localities.get(a["LOCALITY_PID"], ""), a["POSTCODE"])
    del seen

    count = 0
    for g in rows(archive, member("ADDRESS_DEFAULT_GEOCODE")):
        found = wanted.pop(g["ADDRESS_DETAIL_PID"], None)
        if not found or not g["LATITUDE"]:
            continue
        num, street, locality, postcode = found
        count += 1
        place = {
            "place_id": g["ADDRESS_DETAIL_PID"],
            "object_type": "N",
            "object_id": count,
            "osm_key": "place",
            "osm_value": "house",
            "categories": ["osm.place.house"],
            "address_type": "house",
            "importance": 0.00001,
            "housenumber": num,
            "address": {"street": street, "city": locality, "state": STATES[state]},
            "postcode": postcode,
            "country_code": "au",
            "centroid": [round(float(g["LONGITUDE"]), 7), round(float(g["LATITUDE"]), 7)],
        }
        out.write(json.dumps({"type": "Place", "content": [place]}, separators=(",", ":")) + "\n")
    print(f"addresses: {state} {count}", file=sys.stderr, flush=True)


def main():
    out = sys.stdout
    dropped = kept = 0
    # OSM's dump, less its bare addresses.
    for line in sys.stdin:
        if line.lstrip().startswith('{"type":"Place"'):
            doc = json.loads(line)
            content = [c for c in doc["content"] if c.get("name") or not c.get("housenumber")]
            dropped += len(doc["content"]) - len(content)
            if not content:
                continue
            kept += len(content)
            if len(content) != len(doc["content"]):
                doc["content"] = content
                line = json.dumps(doc, separators=(",", ":")) + "\n"
        out.write(line)
    print(f"addresses: OSM places kept {kept}, bare addresses dropped {dropped}", file=sys.stderr, flush=True)
    with zipfile.ZipFile(sys.argv[1]) as archive:
        names = archive.namelist()
        for state in STATES:
            state_places(archive, names, state, out)
    out.flush()


if __name__ == "__main__":
    main()
