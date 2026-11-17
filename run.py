#!/usr/bin/env python3
"""
Colorado Precipitation vs. Wildland Fire web map.

    python run.py              # download data (first run only) and start the server
    python run.py --refresh    # re-download everything
    python run.py --port 8080  # use a different port
    python run.py --no-serve   # only download / build the data

Only the Python 3.8+ standard library is used - nothing to pip install.

Data sources (downloaded once, then cached in ./cache and ./web/data):
  * PRISM Climate Group, Oregon State University - annual total precipitation
    grids, 4 km, one per year (https://prism.oregonstate.edu).
  * National Interagency Fire Center - InterAgencyFirePerimeterHistory_All_Years_View
    (historic wildland fire perimeters).
"""

import argparse
import io
import json
import math
import os
import socket
import struct
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
DATA_DIR = os.path.join(WEB_DIR, "data")
CACHE_DIR = os.path.join(HERE, "cache")

# Colorado's borders follow lines of latitude/longitude, so a 4-corner polygon is accurate.
CO_WEST, CO_EAST, CO_SOUTH, CO_NORTH = -109.0603, -102.0420, 36.9925, 41.0034
# Precip grid is clipped with a small margin so the edges look clean.
MARGIN = 0.25

PRISM_URL = "https://services.nacse.org/prism/data/get/us/4km/ppt/{year}?format={fmt}"
FIRE_URL = ("https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
            "InterAgencyFirePerimeterHistory_All_Years_View/FeatureServer/0/query")

UA = {"User-Agent": "colorado-fire-precip-map/1.0 (personal research map)"}


def log(msg):
    print(msg, flush=True)


def http_get(url, timeout=120, retries=3):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Download failed: {url}\n  {last}")


# --------------------------------------------------------------------------- PRISM
def parse_hdr(text):
    hdr = {}
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2:
            hdr[parts[0].upper()] = parts[1]
    return hdr


def read_bil_zip(blob):
    """Return dict(ncols, nrows, x0, y0, dx, dy, nodata, get(row, col)) from a PRISM BIL zip.
    x0 / y0 are the CENTER of the upper-left cell."""
    z = zipfile.ZipFile(io.BytesIO(blob))
    names = z.namelist()
    bil = next((n for n in names if n.lower().endswith(".bil")), None)
    hdrn = next((n for n in names if n.lower().endswith(".hdr")), None)
    if not bil or not hdrn:
        raise ValueError("zip has no .bil/.hdr")
    hdr = parse_hdr(z.read(hdrn).decode("latin-1"))
    ncols, nrows = int(hdr["NCOLS"]), int(hdr["NROWS"])
    nbits = int(hdr.get("NBITS", 32))
    ptype = hdr.get("PIXELTYPE", "FLOAT").upper()
    endian = ">" if hdr.get("BYTEORDER", "I").upper() in ("M", "MOTOROLA", "BIG") else "<"
    code = {(32, "FLOAT"): "f", (64, "FLOAT"): "d", (16, "SIGNEDINT"): "h",
            (32, "SIGNEDINT"): "i", (16, "UNSIGNEDINT"): "H"}.get((nbits, ptype), "f")
    raw = z.read(bil)
    vals = struct.unpack(f"{endian}{ncols * nrows}{code}", raw[: ncols * nrows * nbits // 8])
    nodata = float(hdr.get("NODATA", -9999))
    return dict(ncols=ncols, nrows=nrows,
                x0=float(hdr["ULXMAP"]), y0=float(hdr["ULYMAP"]),
                dx=float(hdr["XDIM"]), dy=float(hdr["YDIM"]),
                nodata=nodata, get=lambda r, c: vals[r * ncols + c])


def read_asc_zip(blob):
    """ESRI ASCII grid fallback."""
    z = zipfile.ZipFile(io.BytesIO(blob))
    asc = next((n for n in z.namelist() if n.lower().endswith(".asc")), None)
    if not asc:
        raise ValueError("zip has no .asc")
    lines = z.read(asc).decode("latin-1").split("\n")
    hdr, i = {}, 0
    while i < len(lines) and lines[i][:1].isalpha():
        k, v = lines[i].split()[:2]
        hdr[k.lower()] = float(v)
        i += 1
    ncols, nrows = int(hdr["ncols"]), int(hdr["nrows"])
    cs = hdr["cellsize"]
    if "xllcenter" in hdr:
        x0, yll = hdr["xllcenter"], hdr["yllcenter"]
    else:
        x0, yll = hdr["xllcorner"] + cs / 2, hdr["yllcorner"] + cs / 2
    y0 = yll + (nrows - 1) * cs
    vals = [float(t) for t in " ".join(lines[i:]).split()]
    return dict(ncols=ncols, nrows=nrows, x0=x0, y0=y0, dx=cs, dy=cs,
                nodata=hdr.get("nodata_value", -9999),
                get=lambda r, c: vals[r * ncols + c])


def fetch_prism_year(year, refresh=False):
    os.makedirs(CACHE_DIR, exist_ok=True)
    errors = []
    for fmt, reader in (("bil", read_bil_zip), ("asc", read_asc_zip)):
        path = os.path.join(CACHE_DIR, f"prism_ppt_{year}_{fmt}.zip")
        try:
            if refresh or not os.path.exists(path):
                blob = http_get(PRISM_URL.format(year=year, fmt=fmt))
                if not blob.startswith(b"PK"):
                    raise ValueError(blob[:200].decode("latin-1", "replace").strip())
                with open(path, "wb") as f:
                    f.write(blob)
                time.sleep(1.0)  # be polite to the PRISM service
            with open(path, "rb") as f:
                return reader(f.read())
        except Exception as e:  # noqa: BLE001
            errors.append(f"{fmt}: {e}")
            if os.path.exists(path):
                os.remove(path)
    raise RuntimeError(f"PRISM {year} failed -> " + " | ".join(errors))


def build_precip(start, end, refresh=False):
    years, grids, geo = [], [], None
    for y in range(start, end + 1):
        log(f"  PRISM precipitation {y} ...")
        try:
            g = fetch_prism_year(y, refresh)
        except RuntimeError as e:
            log(f"    skipped ({e})")
            continue
        c0 = max(0, int(math.floor((CO_WEST - MARGIN - g["x0"]) / g["dx"])))
        c1 = min(g["ncols"] - 1, int(math.ceil((CO_EAST + MARGIN - g["x0"]) / g["dx"])))
        r0 = max(0, int(math.floor((g["y0"] - (CO_NORTH + MARGIN)) / g["dy"])))
        r1 = min(g["nrows"] - 1, int(math.ceil((g["y0"] - (CO_SOUTH - MARGIN)) / g["dy"])))
        this_geo = dict(ncols=c1 - c0 + 1, nrows=r1 - r0 + 1, dx=g["dx"], dy=g["dy"],
                        west=g["x0"] + c0 * g["dx"] - g["dx"] / 2,
                        north=g["y0"] - r0 * g["dy"] + g["dy"] / 2)
        if geo is None:
            geo = this_geo
        elif (geo["ncols"], geo["nrows"]) != (this_geo["ncols"], this_geo["nrows"]):
            log("    skipped (grid size differs from earlier years)")
            continue
        out = []
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                v = g["get"](r, c)
                if v is None or v <= g["nodata"] + 1 or v < -1000:
                    out.append(-1)
                else:
                    out.append(round(v / 25.4 * 10))  # mm -> tenths of an inch
        years.append(y)
        grids.append(out)
    if not grids:
        raise RuntimeError("No PRISM years could be downloaded.")
    n = len(grids[0])
    mean = []
    for i in range(n):
        vs = [g[i] for g in grids if g[i] >= 0]
        mean.append(round(sum(vs) / len(vs)) if vs else -1)
    return dict(units="tenths of an inch", source="PRISM Climate Group, Oregon State University",
                years=years, mean=mean, grids={str(y): g for y, g in zip(years, grids)},
                co_bounds=[CO_WEST, CO_SOUTH, CO_EAST, CO_NORTH], **geo)


# --------------------------------------------------------------------------- Fires
def ring_area(ring):
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return a / 2.0


def esri_to_geojson_geom(g):
    """Convert esriJSON polygon rings to GeoJSON (outer rings are clockwise)."""
    rings = g.get("rings") or []
    polys = []
    for ring in rings:
        if ring_area(ring) < 0 or not polys:  # clockwise -> outer
            polys.append([ring])
        else:
            polys[-1].append(ring)
    if not polys:
        return None
    return {"type": "MultiPolygon", "coordinates": polys} if len(polys) > 1 else \
        {"type": "Polygon", "coordinates": polys[0]}


def pick(props, *keys):
    lower = {k.lower(): v for k, v in props.items()}
    for k in keys:
        v = lower.get(k.lower())
        if v not in (None, "", " "):
            return v
    return None


def iter_coords(geom):
    if not geom:
        return
    t, cs = geom["type"], geom["coordinates"]
    polys = cs if t == "MultiPolygon" else [cs]
    for p in polys:
        for ring in p:
            for pt in ring:
                yield pt


def fetch_fire_pages(fmt):
    page, offset, feats = 1000, 0, []
    while True:
        params = {
            "where": "1=1",
            "geometry": f"{CO_WEST},{CO_SOUTH},{CO_EAST},{CO_NORTH}",
            "geometryType": "esriGeometryEnvelope", "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects", "outFields": "*",
            "returnGeometry": "true", "outSR": "4326",
            "maxAllowableOffset": "0.0008", "geometryPrecision": "5",
            "resultOffset": str(offset), "resultRecordCount": str(page),
            "f": fmt,
        }
        url = FIRE_URL + "?" + urllib.parse.urlencode(params)
        data = json.loads(http_get(url, timeout=180))
        if "error" in data:
            raise RuntimeError(data["error"])
        batch = data.get("features", [])
        if fmt == "json":
            batch = [{"type": "Feature", "properties": f.get("attributes", {}),
                      "geometry": esri_to_geojson_geom(f.get("geometry") or {})} for f in batch]
        feats.extend(batch)
        log(f"    {len(feats)} perimeters ...")
        more = data.get("exceededTransferLimit") or \
            (data.get("properties") or {}).get("exceededTransferLimit")
        if not batch or (not more and len(batch) < page):
            break
        offset += len(batch)
    return feats


def build_fires():
    log("  NIFC fire perimeter history (Colorado) ...")
    try:
        raw = fetch_fire_pages("geojson")
    except Exception as e:  # noqa: BLE001
        log(f"    geojson query failed ({e}); retrying as esri json")
        raw = fetch_fire_pages("json")

    out, seen = [], set()
    for f in raw:
        geom, p = f.get("geometry"), f.get("properties") or {}
        if not geom:
            continue
        pts = list(iter_coords(geom))
        if not pts:
            continue
        cx = sum(pt[0] for pt in pts) / len(pts)
        cy = sum(pt[1] for pt in pts) / len(pts)
        if not (CO_WEST <= cx <= CO_EAST and CO_SOUTH <= cy <= CO_NORTH):
            continue  # perimeter belongs to a neighbouring state
        year = pick(p, "FIRE_YEAR_INT", "FIRE_YEAR", "FIRE_YEAR_", "YEAR")
        try:
            year = int(str(year)[:4])
        except (TypeError, ValueError):
            continue
        acres = pick(p, "GIS_ACRES", "GISACRES", "ACRES")
        try:
            acres = round(float(acres), 1)
        except (TypeError, ValueError):
            acres = None
        name = str(pick(p, "INCIDENT", "INCIDENTNAME", "FIRE_NAME", "UNQE_FIRE_") or "Unnamed").strip().title()
        kind_txt = " ".join(str(pick(p, k) or "") for k in
                            ("FEATURE_CA", "FEATURE_CAT", "INCIDENTTYPECATEGORY", "INCIDENT_TYPE", "COMMENTS"))
        prescribed = ("prescribed" in kind_txt.lower()) or (" rx" in f" {kind_txt.lower()}")
        key = (name.lower(), year, round(acres or 0))
        if key in seen:
            continue  # same fire reported by more than one agency
        seen.add(key)
        out.append({"type": "Feature", "geometry": geom,
                    "properties": {"name": name, "year": year, "acres": acres,
                                   "agency": pick(p, "AGENCY"), "rx": prescribed,
                                   "cx": round(cx, 4), "cy": round(cy, 4)}})
    out.sort(key=lambda f: -(f["properties"]["acres"] or 0))  # big fires drawn first
    log(f"    kept {len(out)} Colorado perimeters")
    return {"type": "FeatureCollection",
            "source": "National Interagency Fire Center - Interagency Fire Perimeter History",
            "features": out}


# --------------------------------------------------------------------------- Server
def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class QuietHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".json": "application/json", ".geojson": "application/geo+json",
                      ".js": "text/javascript"}

    def log_message(self, fmt, *args):
        pass


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    log(f"  wrote {os.path.relpath(path, HERE)} ({os.path.getsize(path) / 1e6:.1f} MB)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0", help="0.0.0.0 = reachable from your LAN; 127.0.0.1 = this computer only")
    ap.add_argument("--start", type=int, default=2000, help="first year of precipitation data")
    ap.add_argument("--end", type=int, default=2024, help="last year of precipitation data")
    ap.add_argument("--refresh", action="store_true", help="re-download all data")
    ap.add_argument("--no-serve", action="store_true", help="build data only, don't start the server")
    a = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    precip_path = os.path.join(DATA_DIR, "precip.json")
    fires_path = os.path.join(DATA_DIR, "fires.geojson")

    if a.refresh or not os.path.exists(precip_path):
        log(f"Building precipitation grid {a.start}-{a.end} (first run takes a few minutes) ...")
        write_json(precip_path, build_precip(a.start, a.end, a.refresh))
    if a.refresh or not os.path.exists(fires_path):
        log("Building fire perimeters ...")
        write_json(fires_path, build_fires())

    if a.no_serve:
        return
    httpd = ThreadingHTTPServer((a.host, a.port), partial(QuietHandler, directory=WEB_DIR))
    log("\nColorado Precipitation & Wildfire map is running:")
    log(f"  this computer : http://localhost:{a.port}")
    if a.host == "0.0.0.0":
        log(f"  your network  : http://{lan_ip()}:{a.port}")
    log("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("\nStopped.")


if __name__ == "__main__":
    sys.exit(main())
