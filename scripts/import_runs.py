#!/usr/bin/env python3
"""One-off import of runs from another app (e.g. Mi Fitness export) into site/data.

Usage: python scripts/import_runs.py runs.json

runs.json: list of run summaries in the same format as site/data/runs.json,
plus an optional "gpx" URL per run. Routes are downloaded from that URL.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync  # noqa: E402

TRKPT = re.compile(rb'<trkpt[^>]*?\blat="([-0-9.]+)"[^>]*?\blon="([-0-9.]+)"|<trkpt[^>]*?\blon="([-0-9.]+)"[^>]*?\blat="([-0-9.]+)"')


def gpx_points(data: bytes):
    pts = []
    for m in TRKPT.finditer(data):
        lat, lon = (m.group(1), m.group(2)) if m.group(1) else (m.group(4), m.group(3))
        lat, lon = float(lat), float(lon)
        if not (lat == 0 and lon == 0):
            pts.append((lat, lon))
    return pts


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "run-calendar/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def main(path: str) -> int:
    incoming = json.loads(Path(path).read_text(encoding="utf-8"))
    runs = sync.load_runs()
    sync.TRACKS_DIR.mkdir(parents=True, exist_ok=True)
    ok = 0
    for item in incoming:
        url = item.pop("gpx", None)
        run = {**item, "id": int(item["id"]), "track": "none"}
        if url:
            try:
                pts = sync.simplify(gpx_points(fetch(url)), sync.SIMPLIFY_METERS)
                if len(pts) >= 2:
                    track = [[round(a, 5), round(b, 5)] for a, b in pts]
                    (sync.TRACKS_DIR / f"{run['id']}.json").write_text(json.dumps(track, separators=(",", ":")), encoding="utf-8")
                    run["track"] = "ok"
                    ok += 1
                else:
                    run["track"] = "empty"
            except Exception as exc:
                print(f"Маршрут {run['date']} не получен: {exc}")
            time.sleep(0.2)
        runs[run["id"]] = run
    sync.save_runs(runs)
    print(f"Импортировано пробежек: {len(incoming)}, с маршрутом: {ok}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
