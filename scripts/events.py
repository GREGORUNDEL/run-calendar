#!/usr/bin/env python3
"""Add, update or delete a calendar event (trip) in site/data/events.json.

Inputs come from environment variables set by the events workflow:
  EVENT_ACTION  add | update | delete
  EVENT_ID      id of the event (update/delete; optional for add)
  EVENT_TITLE   short title, e.g. "Прага"
  EVENT_START   YYYY-MM-DD
  EVENT_END     YYYY-MM-DD (inclusive)
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import date
from pathlib import Path

FILE = Path(__file__).resolve().parent.parent / "site" / "data" / "events.json"


def fail(msg: str) -> int:
    print(f"::error::{msg}")
    return 1


def main() -> int:
    action = os.environ.get("EVENT_ACTION", "").strip()
    eid = os.environ.get("EVENT_ID", "").strip()
    title = " ".join(os.environ.get("EVENT_TITLE", "").split())[:40]
    start = os.environ.get("EVENT_START", "").strip()
    end = os.environ.get("EVENT_END", "").strip() or start

    data = json.loads(FILE.read_text(encoding="utf-8")) if FILE.exists() else {"events": []}
    events = data.get("events", [])

    if action == "delete":
        before = len(events)
        events = [e for e in events if e.get("id") != eid]
        if len(events) == before:
            print(f"Событие {eid} не найдено, ничего не изменено")
    elif action in ("add", "update"):
        if not title:
            return fail("Пустое название события")
        try:
            d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
        except ValueError:
            return fail(f"Неверные даты: {start} – {end}")
        if d1 < d0:
            d0, d1 = d1, d0
        item = {"id": eid or uuid.uuid4().hex[:10], "title": title, "start": d0.isoformat(), "end": d1.isoformat()}
        events = [e for e in events if e.get("id") != item["id"]] + [item]
    else:
        return fail(f"Неизвестное действие: {action!r}")

    events.sort(key=lambda e: (e["start"], e["end"]))
    FILE.parent.mkdir(parents=True, exist_ok=True)
    FILE.write_text(json.dumps({"events": events}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Событий: {len(events)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
