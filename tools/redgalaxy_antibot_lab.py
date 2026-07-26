#!/usr/bin/env python3
"""
RedGalaxy AntiBot Lab.

This tool does not control the game client and does not connect to a server.
It analyzes telemetry/replay events or generates synthetic data so bot-like
patterns can be studied safely.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


AUTOMATION_ACTIONS = {
    "npc_kill",
    "box_collect",
    "mineral_collect",
    "target_lock",
    "attack_start",
}


@dataclass
class Event:
    ts: float
    user_id: str
    type: str
    x: float | None = None
    y: float | None = None
    target_name: str = ""
    resource_type: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class Flag:
    name: str
    points: int
    detail: str


def parse_ts(value: Any) -> float:
    if isinstance(value, (int, float)):
        number = float(value)
        return number / 1000.0 if number > 10_000_000_000 else number

    text = str(value or "").strip()
    if not text:
        raise ValueError("missing timestamp")
    if text.isdigit():
        return parse_ts(int(text))
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text).timestamp()


def as_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_event(row: dict[str, Any]) -> Event:
    event_type = str(row.get("type") or row.get("event") or row.get("action") or "").strip()
    user_id = str(row.get("user_id") or row.get("player_id") or row.get("account") or "").strip()
    if not event_type:
        raise ValueError("event type missing")
    if not user_id:
        raise ValueError("user_id/player_id missing")
    ts = parse_ts(row.get("ts") or row.get("timestamp") or row.get("time"))
    return Event(
        ts=ts,
        user_id=user_id,
        type=event_type,
        x=as_float(row.get("x")),
        y=as_float(row.get("y")),
        target_name=str(row.get("target_name") or row.get("npc_name") or row.get("target") or ""),
        resource_type=str(row.get("resource_type") or row.get("mineral_type") or row.get("box_type") or ""),
        raw=row,
    )


def load_events(path: Path) -> list[Event]:
    events: list[Event] = []
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                events.append(normalize_event(row))
    else:
        with path.open(encoding="utf-8") as handle:
            for line_no, line in enumerate(handle, 1):
                text = line.strip()
                if not text or text.startswith("#"):
                    continue
                try:
                    events.append(normalize_event(json.loads(text)))
                except Exception as exc:
                    raise SystemExit(f"{path}:{line_no}: {exc}") from exc
    events.sort(key=lambda e: (e.user_id, e.ts))
    return events


def entropy(values: list[str]) -> float:
    values = [value for value in values if value]
    if not values:
        return 0.0
    total = len(values)
    counts = Counter(values)
    return max(0.0, -sum((count / total) * math.log2(count / total) for count in counts.values()))


def intervals(events: list[Event], wanted: set[str]) -> list[float]:
    selected = [event.ts for event in events if event.type in wanted]
    return [b - a for a, b in zip(selected, selected[1:]) if b > a]


def coefficient_of_variation(values: list[float]) -> float | None:
    if len(values) < 3:
        return None
    mean = statistics.fmean(values)
    if mean <= 0:
        return None
    return statistics.pstdev(values) / mean


def short_interval_cluster(values: list[float], tolerance: float = 0.25) -> float:
    if not values:
        return 0.0
    median = statistics.median(values)
    inside = sum(1 for value in values if abs(value - median) <= tolerance)
    return inside / len(values)


def reaction_times(events: list[Event]) -> list[float]:
    pending_lock: tuple[float, str] | None = None
    reactions: list[float] = []
    for event in events:
        if event.type == "target_lock":
            pending_lock = (event.ts, event.target_name)
        elif event.type == "attack_start" and pending_lock:
            locked_at, target = pending_lock
            if not target or not event.target_name or target == event.target_name:
                delta = event.ts - locked_at
                if 0 <= delta <= 10:
                    reactions.append(delta)
            pending_lock = None
    return reactions


def movement_speeds(events: list[Event]) -> list[float]:
    moves = [event for event in events if event.type == "move" and event.x is not None and event.y is not None]
    speeds: list[float] = []
    for a, b in zip(moves, moves[1:]):
        dt = b.ts - a.ts
        if dt <= 0 or dt > 30:
            continue
        distance = math.hypot((b.x or 0) - (a.x or 0), (b.y or 0) - (a.y or 0))
        speeds.append(distance / dt)
    return speeds


def repeated_grid_route(events: list[Event], cell_size: int = 250, window: int = 8) -> tuple[int, int]:
    cells = []
    for event in events:
        if event.type == "move" and event.x is not None and event.y is not None:
            cells.append((int(event.x // cell_size), int(event.y // cell_size)))
    if len(cells) < window * 2:
        return 0, 0
    grams = Counter(tuple(cells[i : i + window]) for i in range(0, len(cells) - window + 1))
    repeated = sum(count for count in grams.values() if count > 1)
    return repeated, len(grams)


def analyze_user(events: list[Event]) -> dict[str, Any]:
    flags: list[Flag] = []

    def add(name: str, points: int, detail: str) -> None:
        flags.append(Flag(name, points, detail))

    first_ts = events[0].ts
    last_ts = events[-1].ts
    duration = max(1.0, last_ts - first_ts)
    counts = Counter(event.type for event in events)

    action_intervals = intervals(events, AUTOMATION_ACTIONS)
    cv = coefficient_of_variation(action_intervals)
    if cv is not None and len(action_intervals) >= 20:
        mean = statistics.fmean(action_intervals)
        if cv < 0.08 and mean < 15:
            add("regular_action_cadence", 30, f"automation actions every {mean:.2f}s with CV {cv:.3f}")
        elif cv < 0.16 and mean < 20:
            add("low_jitter_action_cadence", 18, f"low timing variation, CV {cv:.3f}")

        clustered = short_interval_cluster(action_intervals)
        if clustered >= 0.85:
            add("interval_clustering", 20, f"{clustered:.0%} of intervals are near the median")

    reactions = reaction_times(events)
    if len(reactions) >= 10:
        median = statistics.median(reactions)
        jitter = coefficient_of_variation(reactions) or 0
        if median < 0.12:
            add("machine_like_reaction", 30, f"median target->attack reaction {median * 1000:.0f}ms")
        elif median < 0.25:
            add("fast_reaction", 15, f"median target->attack reaction {median * 1000:.0f}ms")
        if jitter < 0.12:
            add("reaction_low_jitter", 12, f"reaction time CV {jitter:.3f}")

    speeds = movement_speeds(events)
    speed_cv = coefficient_of_variation(speeds)
    if speed_cv is not None and len(speeds) >= 25:
        if speed_cv < 0.05:
            add("constant_movement_speed", 16, f"movement speed CV {speed_cv:.3f}")
        elif speed_cv < 0.10:
            add("low_jitter_movement_speed", 8, f"movement speed CV {speed_cv:.3f}")

    repeated, unique_routes = repeated_grid_route(events)
    if unique_routes and repeated >= 12:
        add("repeated_route", 14, f"{repeated} repeated route windows across {unique_routes} unique windows")

    target_values = [event.target_name or event.resource_type for event in events if event.type in AUTOMATION_ACTIONS]
    target_entropy = entropy(target_values)
    if len(target_values) >= 30 and target_entropy < 1.0:
        add("narrow_target_selection", 6, f"target/resource entropy {target_entropy:.2f}")

    active_minutes = duration / 60.0
    actions_per_minute = sum(counts[event_type] for event_type in AUTOMATION_ACTIONS) / max(1.0, active_minutes)
    if active_minutes >= 20 and actions_per_minute > 18:
        add("high_sustained_action_rate", 12, f"{actions_per_minute:.1f} automation actions/min over {active_minutes:.1f}min")

    long_gaps = sum(1 for gap in action_intervals if gap >= 60)
    if active_minutes >= 60 and len(action_intervals) >= 200 and long_gaps == 0:
        add("no_human_breaks", 10, "no action gap >= 60s during a long active window")

    score = min(100, sum(flag.points for flag in flags))
    if score >= 70:
        verdict = "likely_bot"
    elif score >= 40:
        verdict = "suspicious"
    elif score >= 20:
        verdict = "watch"
    else:
        verdict = "normal"

    return {
        "user_id": events[0].user_id,
        "verdict": verdict,
        "score": score,
        "duration_minutes": round(active_minutes, 2),
        "counts": dict(sorted(counts.items())),
        "metrics": {
            "actions_per_minute": round(actions_per_minute, 2),
            "action_interval_cv": None if cv is None else round(cv, 4),
            "reaction_median_ms": None if not reactions else round(statistics.median(reactions) * 1000, 1),
            "movement_speed_cv": None if speed_cv is None else round(speed_cv, 4),
            "target_entropy": round(target_entropy, 3),
        },
        "flags": [flag.__dict__ for flag in flags],
    }


def analyze(events: list[Event]) -> list[dict[str, Any]]:
    by_user: dict[str, list[Event]] = defaultdict(list)
    for event in events:
        by_user[event.user_id].append(event)
    return [analyze_user(user_events) for _, user_events in sorted(by_user.items())]


def iso(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def emit(writer, ts: datetime, user: str, event_type: str, **extra: Any) -> None:
    row = {"ts": iso(ts), "user_id": user, "type": event_type}
    row.update(extra)
    writer.write(json.dumps(row, separators=(",", ":")) + "\n")


def make_sample(path: Path, seed: int = 42) -> None:
    random.seed(seed)
    start = datetime(2026, 7, 6, 10, 0, tzinfo=timezone.utc)
    npcs = ["Raider", "Scout", "Helios", "Marauder", "Sentinel"]
    minerals = ["prometium", "endurium", "terbium", "xenomit"]
    boxes = ["bonus_box", "cargo_box", "booty_box"]

    with path.open("w", encoding="utf-8") as handle:
        for user in ("human_alfa", "human_beta"):
            now = start
            x = random.randint(900, 1300)
            y = random.randint(800, 1400)
            for _ in range(90):
                now += timedelta(seconds=random.uniform(4, 35))
                x += random.uniform(-160, 180)
                y += random.uniform(-140, 160)
                emit(handle, now, user, "move", x=round(x, 1), y=round(y, 1))
                if random.random() < 0.58:
                    npc = random.choice(npcs)
                    emit(handle, now + timedelta(seconds=random.uniform(0.2, 1.8)), user, "target_lock", target_name=npc)
                    emit(handle, now + timedelta(seconds=random.uniform(0.8, 3.4)), user, "attack_start", target_name=npc)
                    emit(handle, now + timedelta(seconds=random.uniform(5, 13)), user, "npc_kill", target_name=npc)
                elif random.random() < 0.7:
                    emit(handle, now + timedelta(seconds=random.uniform(0.5, 4.5)), user, "box_collect", resource_type=random.choice(boxes))
                else:
                    emit(handle, now + timedelta(seconds=random.uniform(0.5, 5.0)), user, "mineral_collect", resource_type=random.choice(minerals))

        for user, fixed_target in (("bot_raider_loop", "Raider"), ("bot_miner_loop", "terbium")):
            now = start
            route = [(1000, 1000), (1250, 1000), (1250, 1250), (1000, 1250)]
            for i in range(180):
                now += timedelta(seconds=3.25)
                x, y = route[i % len(route)]
                emit(handle, now, user, "move", x=x, y=y)
                if user == "bot_raider_loop":
                    emit(handle, now + timedelta(seconds=0.04), user, "target_lock", target_name=fixed_target)
                    emit(handle, now + timedelta(seconds=0.09), user, "attack_start", target_name=fixed_target)
                    emit(handle, now + timedelta(seconds=1.6), user, "npc_kill", target_name=fixed_target)
                else:
                    event_type = "mineral_collect" if i % 2 else "box_collect"
                    emit(handle, now + timedelta(seconds=0.12), user, event_type, resource_type=fixed_target)


def print_text(results: list[dict[str, Any]]) -> None:
    for result in sorted(results, key=lambda item: item["score"], reverse=True):
        print(f"{result['user_id']}: {result['verdict']} score={result['score']} duration={result['duration_minutes']}m")
        metrics = result["metrics"]
        print(
            "  metrics: "
            f"actions/min={metrics['actions_per_minute']} "
            f"interval_cv={metrics['action_interval_cv']} "
            f"reaction_ms={metrics['reaction_median_ms']} "
            f"move_cv={metrics['movement_speed_cv']} "
            f"target_entropy={metrics['target_entropy']}"
        )
        if result["flags"]:
            for flag in result["flags"]:
                print(f"  +{flag['points']:02d} {flag['name']}: {flag['detail']}")
        else:
            print("  no strong bot-like flags")
        print()


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze RedGalaxy telemetry for bot-like behavior.")
    sub = parser.add_subparsers(dest="command", required=True)

    sample = sub.add_parser("make-sample", help="write synthetic human/bot JSONL telemetry")
    sample.add_argument("output", type=Path)
    sample.add_argument("--seed", type=int, default=42)

    analyze_cmd = sub.add_parser("analyze", help="analyze JSONL or CSV telemetry")
    analyze_cmd.add_argument("input", type=Path)
    analyze_cmd.add_argument("--format", choices=("text", "json"), default="text")

    args = parser.parse_args()
    if args.command == "make-sample":
        make_sample(args.output, args.seed)
        print(f"wrote sample telemetry: {args.output}")
        return 0

    events = load_events(args.input)
    results = analyze(events)
    if args.format == "json":
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        print_text(results)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
