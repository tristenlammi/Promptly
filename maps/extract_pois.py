"""Speed cameras and charging stations out of the OSM extract, as two small
JSON files the backend reads. Usage: extract_pois.py <file.geojsonseq> <out dir>"""
import json
import re
import sys
from pathlib import Path

# OSM's socket:* tags, with the names people know them by.
SOCKETS = {
    "type2": "Type 2",
    "type2_cable": "Type 2 (tethered)",
    "type2_combo": "CCS2",
    "chademo": "CHAdeMO",
    "tesla_supercharger": "Tesla",
    "tesla_supercharger_ccs": "Tesla (CCS)",
    "type1": "Type 1",
    "type1_combo": "CCS1",
    "nacs": "NACS",
    "as3112": "Household",
    "schuko": "Household",
}


def centre(geometry):
    """A representative point: the point itself, or the middle of its outline."""
    kind, coords = geometry.get("type"), geometry.get("coordinates")
    if kind == "Point":
        return coords
    flat = []

    def walk(c):
        if c and isinstance(c[0], (int, float)):
            flat.append(c)
        else:
            for x in c or []:
                walk(x)

    walk(coords)
    if not flat:
        return None
    return [sum(p[0] for p in flat) / len(flat), sum(p[1] for p in flat) / len(flat)]


def number(text):
    m = re.search(r"\d+(\.\d+)?", str(text or ""))
    return float(m.group()) if m else None


def power_kw(text):
    """"50 kW", "7400 W", "22" -> kilowatts, or None."""
    n = number(text)
    if n is None:
        return None
    low = str(text).lower()
    if "kw" in low:
        return n
    if low.rstrip().endswith("w"):
        return n / 1000
    return n if n < 1000 else n / 1000


def charger(p, lon, lat):
    sockets = []
    for tag, label in SOCKETS.items():
        count = p.get(f"socket:{tag}")
        if count in (None, "no"):
            continue
        sockets.append({
            "type": label,
            "count": int(number(count) or 1) if count != "yes" else None,
            "kw": power_kw(p.get(f"socket:{tag}:output")),
        })
    kw = [s["kw"] for s in sockets if s["kw"]] or ([power_kw(p["charging_station:output"])] if p.get("charging_station:output") else [])
    return {
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "name": p.get("name") or p.get("brand") or p.get("operator") or "Charging station",
        "operator": p.get("operator") or p.get("brand"),
        "sockets": sockets,
        "max_kw": max((k for k in kw if k), default=None),
        "access": p.get("access"),
        "fee": p.get("fee"),
        "hours": p.get("opening_hours"),
    }


def camera(p, lon, lat):
    return {
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "maxspeed": number(p.get("maxspeed")),
        "direction": number(p.get("direction")),
        "name": p.get("name"),
    }


def main():
    source, out = Path(sys.argv[1]), Path(sys.argv[2])
    cameras, chargers = [], []
    with source.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip("\x1e \r\n")
            if not line:
                continue
            feature = json.loads(line)
            point = centre(feature.get("geometry") or {})
            if not point:
                continue
            props = feature.get("properties") or {}
            if props.get("amenity") == "charging_station":
                chargers.append(charger(props, *point))
            elif props.get("highway") == "speed_camera":
                cameras.append(camera(props, *point))
    (out / "cameras.json").write_text(json.dumps(cameras, separators=(",", ":")), encoding="utf-8")
    (out / "chargers.json").write_text(json.dumps(chargers, separators=(",", ":")), encoding="utf-8")
    print(f"{len(cameras)} cameras, {len(chargers)} chargers")


if __name__ == "__main__":
    main()
