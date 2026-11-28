#!/usr/bin/env python3
"""Print the *shape* of Garmin health endpoints (key names and value types only, no values),
so we know which fields exist before building features on them. Safe for public logs."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync  # noqa: E402

SHOW_VALUE = re.compile(r"recovery", re.I)  # numbers worth seeing (not personal)


def shape(v, depth=0, key=""):
    pad = "  " * depth
    if isinstance(v, dict):
        lines = []
        for k, x in v.items():
            if isinstance(x, (dict, list)) and depth < 3:
                lines.append(f"{pad}{k}: {type(x).__name__}")
                lines.extend(shape(x, depth + 1, k))
            else:
                val = f" = {x!r}" if SHOW_VALUE.search(k) and not isinstance(x, (dict, list)) else ""
                lines.append(f"{pad}{k}: {type(x).__name__}{val}")
        return lines
    if isinstance(v, list):
        out = [f"{pad}[{len(v)} items]"]
        if v and depth < 3:
            out.extend(shape(v[0], depth + 1, key))
        return out
    return [f"{pad}{type(v).__name__}"]


def get(token, path, params=None):
    raw = sync._request("GET", path, headers={"Accept": "application/json", "Authorization": f"Bearer {token}"}, params=params)
    return json.loads(raw) if raw.strip() else None


def main() -> int:
    token = sync.get_token(os.environ["GARMIN_API_KEY"])
    today = date.today()
    d1, d0 = (today - timedelta(days=1)).isoformat(), (today - timedelta(days=3)).isoformat()
    runs = sync.load_runs()
    latest = max((r for r in runs.values() if r.get("source", "garmin") == "garmin"), key=lambda r: r["start"])
    probes = [
        ("sleep summaries", "/sleep-service/sleep/dailySleepSummariesByDate", {"startDate": d0, "endDate": d1}),
        ("sleep day", "/sleep-service/sleep/dailySleep", {"date": d1}),
        ("daily summaries", "/usersummary-service/v2/dailysummaries", {"startDate": d0, "endDate": d1}),
        ("hrv summaries", f"/hrv-service/hrv/daily/{d0}/{d1}", None),
        ("body battery", "/wellness-service/wellness/bodyBattery/reports/daily", {"startDate": d0, "endDate": d1}),
        ("activity detail", f"/activity-service/activity/{latest['id']}", None),
    ]
    for name, path, params in probes:
        print(f"\n===== {name}: {path}")
        try:
            print("\n".join(shape(get(token, path, params))))
        except Exception as exc:  # report and continue
            print(f"ERROR: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
