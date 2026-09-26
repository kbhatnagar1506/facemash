"""Convert raw Overpass output (data/osm.json) into the game's campus map.

Coordinates are local meters: +x east, +z south, origin at the center of
Georgia Tech. Output: client/public/campus.json

    python3 scripts/build_map.py
"""
import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "osm.json"
OUT = ROOT / "client" / "public" / "campus.json"

LAT0, LON0 = 33.7760, -84.3980
M_PER_LAT = 110_540.0
M_PER_LON = 111_320.0 * math.cos(math.radians(LAT0))

EVENT_BUILDING = "Christopher W. Klaus Advanced Computing Building"
# Entrance nodes of the event building (Overpass: way(42706123);node(w)["entrance"];out;)
ENTRANCES = ROOT / "data" / "klaus_entrances.json"
# The HackGT main entrance (OSM entrance=main on the courtyard side), confirmed on site.
MAIN_ENTRANCE = (33.7768401, -84.396261)

ROAD_WIDTH = {
    "motorway": 16, "trunk": 14, "primary": 12, "secondary": 11, "tertiary": 9,
    "motorway_link": 8, "trunk_link": 8, "tertiary_link": 7,
    "residential": 8, "unclassified": 7, "service": 5,
    "pedestrian": 6, "footway": 2.6, "path": 2.4, "cycleway": 3, "steps": 2.6,
}
FOOT = {"footway", "path", "cycleway", "steps", "pedestrian"}

# Pokémon-town palette for roofs; walls are a warm cream with slight variation.
ROOFS = ["#e0564f", "#4f7fd6", "#e89a3c", "#5aa56a", "#9b6bd1", "#d9c24a", "#3fa7b3"]


def proj(lat, lon):
    return (round((lon - LON0) * M_PER_LON, 2), round(-(lat - LAT0) * M_PER_LAT, 2))


def ring(geom):
    pts = [proj(g["lat"], g["lon"]) for g in geom if g]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    return pts


def area(pts):
    return 0.5 * sum(pts[i][0] * pts[i - 1][1] - pts[i - 1][0] * pts[i][1] for i in range(len(pts)))


def centroid(pts):
    xs, zs = zip(*pts)
    return (round(sum(xs) / len(xs), 2), round(sum(zs) / len(zs), 2))


def point_in(pt, poly):
    x, z = pt
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, zi = poly[i]
        xj, zj = poly[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            inside = not inside
        j = i
    return inside


def height(tags):
    try:
        return max(4.0, min(80.0, float(tags["height"].split()[0])))
    except (KeyError, ValueError):
        pass
    try:
        return max(4.0, min(80.0, float(tags["building:levels"]) * 3.6 + 1.5))
    except (KeyError, ValueError):
        return 9.0


def entrances(poly):
    """Doors of the event building, each nudged 3.5 m outside the wall.

    Returns [x, z, facing] where facing (radians about +y) points away from the door.
    """
    if not ENTRANCES.exists():
        return []
    out = []
    for e in json.loads(ENTRANCES.read_text())["elements"]:
        if e.get("tags", {}).get("entrance") == "exit":
            continue
        x, z = proj(e["lat"], e["lon"])
        if any(math.hypot(x - o[0], z - o[1]) < 12 for o in out):
            continue  # doors this close share one shell
        # Outward normal of the nearest wall segment.
        best = None
        for i in range(len(poly)):
            (ax, az), (bx, bz) = poly[i - 1], poly[i]
            dx, dz = bx - ax, bz - az
            L2 = dx * dx + dz * dz or 1
            t = max(0, min(1, ((x - ax) * dx + (z - az) * dz) / L2))
            d = math.hypot(x - (ax + t * dx), z - (az + t * dz))
            if best is None or d < best[0]:
                L = math.sqrt(L2)
                best = (d, -dz / L, dx / L)
        _, nx, nz = best
        if point_in((x + nx * 3.5, z + nz * 3.5), poly):
            nx, nz = -nx, -nz
        out.append([round(x + nx * 3.5, 2), round(z + nz * 3.5, 2),
                    round(math.atan2(nx, nz), 3)])
    return out


def main():
    els = json.loads(SRC.read_text())["elements"]
    rnd = random.Random(1885)  # GT founding year: deterministic map
    buildings, roads, areas, trees = [], [], [], []
    event = None

    for e in els:
        t = e.get("tags", {})
        if e["type"] == "node":
            if t.get("natural") == "tree":
                trees.append(proj(e["lat"], e["lon"]))
            continue

        if e["type"] == "relation":
            rings = [ring(m["geometry"]) for m in e.get("members", [])
                     if m.get("role") == "outer" and m.get("geometry")]
        else:
            rings = [ring(e.get("geometry", []))]

        if "building" in t:
            for pts in rings:
                if len(pts) < 3 or abs(area(pts)) < 12:
                    continue
                if area(pts) < 0:  # normalize winding (counter-clockwise in x/-z)
                    pts.reverse()
                name = t.get("short_name") or t.get("loc_name") or t.get("name") or ""
                b = {
                    "pts": pts,
                    "h": round(height(t), 1),
                    "roof": rnd.choice(ROOFS),
                }
                if name:
                    b["name"] = name
                if t.get("name") == EVENT_BUILDING:
                    b["event"] = True
                    b["roof"] = "#f5b700"
                    event = {"name": "Klaus Advanced Computing Building",
                             "center": centroid(pts), "pts": pts, "h": b["h"]}
                buildings.append(b)
        elif "highway" in t and e["type"] == "way":
            kind = t["highway"]
            if kind not in ROAD_WIDTH or t.get("area") == "yes":
                continue
            pts = [proj(g["lat"], g["lon"]) for g in e.get("geometry", []) if g]
            if len(pts) >= 2:
                roads.append({"pts": pts, "w": ROAD_WIDTH[kind],
                              "foot": kind in FOOT})
        else:
            kind = (t.get("leisure") or t.get("landuse") or t.get("natural")
                    or t.get("amenity"))
            if kind is None:
                continue
            for pts in rings:
                if len(pts) >= 3:
                    areas.append({"pts": pts, "kind": kind})
                    # Scatter trees into woods and parks so the campus feels green.
                    density = {"wood": 1 / 250, "forest": 1 / 250, "park": 1 / 900,
                               "garden": 1 / 500, "grass": 1 / 2500,
                               "recreation_ground": 1 / 2500}.get(kind, 0)
                    n = int(abs(area(pts)) * density)
                    xs, zs = zip(*pts)
                    for _ in range(min(n, 400)):
                        for _try in range(8):
                            p = (round(rnd.uniform(min(xs), max(xs)), 1),
                                 round(rnd.uniform(min(zs), max(zs)), 1))
                            if point_in(p, pts):
                                trees.append(p)
                                break

    # Drop trees that landed on buildings or right on roads.
    grid = {}
    for i, b in enumerate(buildings):
        xs, zs = zip(*b["pts"])
        for gx in range(int(min(xs) // 50), int(max(xs) // 50) + 1):
            for gz in range(int(min(zs) // 50), int(max(zs) // 50) + 1):
                grid.setdefault((gx, gz), []).append(i)
    trees = [p for p in trees
             if not any(point_in(p, buildings[i]["pts"])
                        for i in grid.get((int(p[0] // 50), int(p[1] // 50)), []))]

    if event:
        event["entrances"] = entrances(event["pts"])
        mx, mz = proj(*MAIN_ENTRANCE)
        event["main"] = min(range(len(event["entrances"])),
                            key=lambda i: math.hypot(event["entrances"][i][0] - mx, event["entrances"][i][1] - mz))

    allx = [x for b in buildings for x, _ in b["pts"]]
    allz = [z for b in buildings for _, z in b["pts"]]
    out = {
        "bounds": [min(allx) - 60, min(allz) - 60, max(allx) + 60, max(allz) + 60],
        # start in front of the HackGT main entrance
        "spawn": event["entrances"][event["main"]][:2] if event else [0, 0],
        "event": event,
        "buildings": buildings,
        "roads": roads,
        "areas": areas,
        "trees": trees,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(buildings)} buildings, {len(roads)} roads, {len(areas)} areas, "
          f"{len(trees)} trees -> {OUT.relative_to(ROOT)} "
          f"({OUT.stat().st_size // 1024} KB); event={'yes' if event else 'MISSING'}")


if __name__ == "__main__":
    main()
