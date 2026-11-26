#!/usr/bin/env python3
"""Pull runs from the Garmin Connect Personal API into site/data.

Writes:
  site/data/runs.json          list of runs (summary only)
  site/data/tracks/<id>.json   simplified route per run, start/end trimmed

Environment:
  GARMIN_API_KEY   personal API key (GitHub secret)
  FULL_SYNC        "true" to re-download the whole history
"""

from __future__ import annotations

import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BASE_URL = os.environ.get("GARMIN_PERSONAL_API_BASE_URL", "https://personal.connectapi.garmin.com")
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
SEARCH_PATH = "/activitylist-service/activities/search/activities"
DOWNLOAD_PATH = "/download-service/files/activity/{id}"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "site" / "data"
RUNS_FILE = DATA_DIR / "runs.json"
TRACKS_DIR = DATA_DIR / "tracks"

PAGE_SIZE = 100
MAX_PAGES = 200
INCREMENTAL_OVERLAP_DAYS = 7
MAX_TRACK_DOWNLOADS = int(os.environ.get("MAX_TRACK_DOWNLOADS", "150"))
TRIM_METERS = 0            # metres hidden at start and end of every route (0 = full route)
TRACK_VERSION = 3          # bump to re-download all routes after changing track processing
SIMPLIFY_METERS = 4        # Douglas-Peucker tolerance
TIMEOUT = 60


class SyncError(Exception):
    pass


# --------------------------------------------------------------------------- HTTP

def _request(method: str, path: str, *, headers: dict, params: dict | None = None) -> bytes:
    url = BASE_URL + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method=method, headers={"User-Agent": "run-calendar/1.0", **headers})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:300]
            if exc.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            raise SyncError(f"{method} {path} -> HTTP {exc.code}: {body}") from None
        except urllib.error.URLError as exc:
            if attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            raise SyncError(f"{method} {path} -> {exc.reason}") from None
    raise SyncError(f"{method} {path} failed")


def get_token(api_key: str) -> str:
    try:
        raw = _request("POST", TOKEN_PATH, headers={"Accept": "*/*", "Authorization": f"ApiKey {api_key}"})
    except SyncError as exc:
        if "HTTP 401" in str(exc) or "HTTP 403" in str(exc):
            raise SyncError(
                "Garmin не принял ключ: он недействителен или истёк. "
                "Создай новый ключ в Garmin Connect и обнови секрет GARMIN_API_KEY."
            ) from None
        raise
    token = raw.decode("utf-8").strip()
    if token.count(".") != 2:
        raise SyncError("Garmin вернул токен в неожиданном формате.")
    return token


def search_runs(token: str, start_date: str | None) -> list[dict]:
    headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
    found: list[dict] = []
    for page in range(MAX_PAGES):
        params = {"start": page * PAGE_SIZE, "limit": PAGE_SIZE, "activityType": "running"}
        if start_date:
            params["startDate"] = start_date
            params["endDate"] = (date.today() + timedelta(days=1)).isoformat()
        raw = _request("GET", SEARCH_PATH, headers=headers, params=params)
        batch = _activity_list(json.loads(raw) if raw.strip() else [])
        found.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
    return [a for a in found if is_run(a)]


def download_fit(token: str, activity_id: int) -> bytes | None:
    headers = {
        "Accept": "application/zip, application/x-zip-compressed, application/octet-stream",
        "Authorization": f"Bearer {token}",
    }
    raw = _request("GET", DOWNLOAD_PATH.format(id=int(activity_id)), headers=headers)
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for name in zf.namelist():
                if name.lower().endswith(".fit"):
                    return zf.read(name)
        return None
    return raw or None


# --------------------------------------------------------------------------- data

def _activity_list(value) -> list[dict]:
    if isinstance(value, list):
        return [a for a in value if isinstance(a, dict)]
    if isinstance(value, dict):
        for key in ("activities", "activityList"):
            if isinstance(value.get(key), list):
                return [a for a in value[key] if isinstance(a, dict)]
    return []


def _type_key(activity: dict) -> str:
    t = activity.get("activityType")
    if isinstance(t, dict):
        return str(t.get("typeKey") or "")
    return str(t or "")


def is_run(activity: dict) -> bool:
    return "run" in _type_key(activity).lower()


def _num(value, digits=None):
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return round(f, digits) if digits else round(f)


def summarize(activity: dict) -> dict:
    start = str(activity.get("startTimeLocal") or activity.get("startTimeGMT") or "")
    return {
        "id": int(activity["activityId"]),
        "date": start[:10],
        "start": start[:16],
        "name": activity.get("activityName") or "",
        "type": _type_key(activity),
        "distance": _num(activity.get("distance")),          # m
        "duration": _num(activity.get("duration")),          # s, elapsed
        "moving": _num(activity.get("movingDuration")),      # s
        "avgHr": _num(activity.get("averageHR")),
        "maxHr": _num(activity.get("maxHR")),
        "elevGain": _num(activity.get("elevationGain")),
        "calories": _num(activity.get("calories")),
        "track": "pending",  # FIT not processed yet (route + heart rate)
    }


# --------------------------------------------------------------------------- tracks

HR_FROM, HR_STEP, HR_BINS = 60, 5, 32       # bpm histogram: 60-64, 65-69, ... 215+
HR_MAX_GAP = 10                               # seconds; longer gaps are pauses


def fit_data(fit_bytes: bytes):
    """Route points and a heart-rate histogram (seconds per 5-bpm bin) from a FIT file."""
    import fitdecode

    points: list[tuple[float, float]] = []
    samples: list[tuple[float, int]] = []
    with fitdecode.FitReader(io.BytesIO(fit_bytes), check_crc=fitdecode.CrcCheck.DISABLED,
                             error_handling=fitdecode.ErrorHandling.IGNORE) as fit:
        for frame in fit:
            if frame.frame_type != fitdecode.FIT_FRAME_DATA or frame.name != "record":
                continue
            lat = frame.get_value("position_lat", fallback=None)
            lon = frame.get_value("position_long", fallback=None)
            if lat is not None and lon is not None:
                lat, lon = lat * 180 / 2**31, lon * 180 / 2**31
                if -90 <= lat <= 90 and -180 <= lon <= 180 and not (lat == 0 and lon == 0):
                    points.append((lat, lon))
            hr = frame.get_value("heart_rate", fallback=None)
            ts = frame.get_value("timestamp", fallback=None)
            if hr and ts is not None and 30 <= hr <= 250:
                t = ts.timestamp() if hasattr(ts, "timestamp") else float(ts)
                samples.append((t, int(hr)))

    hist = [0] * HR_BINS
    for (t0, hr), (t1, _) in zip(samples, samples[1:]):
        dt = t1 - t0
        if 0 < dt <= HR_MAX_GAP:
            idx = min(HR_BINS - 1, max(0, (hr - HR_FROM) // HR_STEP))
            hist[idx] += dt
    hist = [round(x) for x in hist]
    while hist and hist[-1] == 0:
        hist.pop()
    return points, ({"from": HR_FROM, "step": HR_STEP, "s": hist} if any(hist) else None)


def fit_points(fit_bytes: bytes) -> list[tuple[float, float]]:
    return fit_data(fit_bytes)[0]


def _dist(a, b) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def trim(points, meters: float):
    """Drop the first and last `meters` of the route (privacy)."""
    if len(points) < 2:
        return []
    if meters <= 0:
        return list(points)
    cum = [0.0]
    for a, b in zip(points, points[1:]):
        cum.append(cum[-1] + _dist(a, b))
    total = cum[-1]
    if total <= 2 * meters + 100:
        return []
    return [p for p, d in zip(points, cum) if meters <= d <= total - meters]


def simplify(points, tolerance: float):
    if len(points) < 3:
        return list(points)
    lat0 = math.radians(points[0][0])
    xy = [(math.radians(lon) * math.cos(lat0) * 6371000, math.radians(lat) * 6371000) for lat, lon in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = xy[i], xy[j]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy)
        best, idx = 0.0, -1
        for k in range(i + 1, j):
            x, y = xy[k]
            d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm if norm else math.hypot(x - x1, y - y1)
            if d > best:
                best, idx = d, k
        if idx != -1 and best > tolerance:
            keep[idx] = True
            stack.extend([(i, idx), (idx, j)])
    return [p for p, k in zip(points, keep) if k]


def process_fit(fit_bytes: bytes):
    points, hr = fit_data(fit_bytes)
    pts = simplify(trim(points, TRIM_METERS), SIMPLIFY_METERS)
    return [[round(lat, 5), round(lon, 5)] for lat, lon in pts], hr


# --------------------------------------------------------------------------- main

def load_runs() -> dict[int, dict]:
    if not RUNS_FILE.exists():
        return {}
    data = json.loads(RUNS_FILE.read_text(encoding="utf-8"))
    runs = {int(r["id"]): r for r in data.get("runs", [])}
    if data.get("trackVersion") != TRACK_VERSION:
        for r in runs.values():
            if r.get("source", "garmin") == "garmin" and r.get("track") in ("ok", "empty", "none"):
                r["track"] = "pending"
    return runs


def save_runs(runs: dict[int, dict]) -> None:
    ordered = sorted(runs.values(), key=lambda r: (r["start"], r["id"]), reverse=True)
    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "trackVersion": TRACK_VERSION,
        "runs": ordered,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def sync(api_key: str, full: bool) -> None:
    runs = load_runs()
    if full:
        runs = {rid: r for rid, r in runs.items() if r.get("source", "garmin") != "garmin"}
    start_date = None
    garmin_runs = [r for r in runs.values() if r.get("source", "garmin") == "garmin" and r.get("date")]
    if garmin_runs and not full:
        newest = max(date.fromisoformat(r["date"]) for r in garmin_runs)
        start_date = (newest - timedelta(days=INCREMENTAL_OVERLAP_DAYS)).isoformat()

    token = get_token(api_key)
    fetched = search_runs(token, start_date)
    print(f"Найдено пробежек в Garmin: {len(fetched)}" + (f" (с {start_date})" if start_date else " (вся история)"))

    fetched_ids = set()
    added = 0
    for activity in fetched:
        summary = summarize(activity)
        fetched_ids.add(summary["id"])
        old = runs.get(summary["id"])
        if old is None:
            added += 1
        elif old.get("track") in ("ok", "empty", "none"):
            summary["track"] = old["track"]
            if old.get("hr"):
                summary["hr"] = old["hr"]
        runs[summary["id"]] = summary

    # Runs deleted in Garmin within the re-fetched window disappear here too.
    if start_date:
        for rid in [rid for rid, r in runs.items()
                    if r.get("source", "garmin") == "garmin" and r["date"] >= start_date and rid not in fetched_ids]:
            print(f"Удалена в Garmin: {runs[rid]['date']} {runs[rid]['name']}")
            runs.pop(rid)
            (TRACKS_DIR / f"{rid}.json").unlink(missing_ok=True)

    TRACKS_DIR.mkdir(parents=True, exist_ok=True)
    if full:
        for f in TRACKS_DIR.glob("*.json"):
            if int(f.stem) not in runs:
                f.unlink()

    pending = sorted((r for r in runs.values()
                      if r.get("track") == "pending" and r.get("source", "garmin") == "garmin"), key=lambda r: r["start"], reverse=True)
    downloads = 0
    for run in pending[:MAX_TRACK_DOWNLOADS]:
        try:
            fit = download_fit(token, run["id"])
            track, hr = process_fit(fit) if fit else ([], None)
        except Exception as exc:  # keep syncing other runs
            print(f"Маршрут {run['date']} не получен: {exc}")
            continue
        downloads += 1
        if hr:
            run["hr"] = hr
        else:
            run.pop("hr", None)
        if track:
            (TRACKS_DIR / f"{run['id']}.json").write_text(json.dumps(track, separators=(",", ":")), encoding="utf-8")
            run["track"] = "ok"
        else:
            run["track"] = "none"
            (TRACKS_DIR / f"{run['id']}.json").unlink(missing_ok=True)
        time.sleep(0.3)

    left = sum(1 for r in runs.values() if r.get("track") == "pending")
    save_runs(runs)
    print(f"Новых пробежек: {added}. Маршрутов загружено: {downloads}." + (f" Ещё ждут загрузки: {left}." if left else ""))


def main() -> int:
    api_key = os.environ.get("GARMIN_API_KEY", "").strip()
    if not api_key:
        print("::error::Секрет GARMIN_API_KEY не задан в настройках репозитория.")
        return 1
    try:
        sync(api_key, full=os.environ.get("FULL_SYNC", "").lower() == "true")
    except SyncError as exc:
        print(f"::error::{exc}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
