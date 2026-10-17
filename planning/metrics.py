"""Accuracy scoreboard vs simulator ground truth (Ali, planning/)."""

import math

ERROR_T_MARKS = (30, 60, 90, 120)


def run(raw: dict, frames: list[dict]) -> dict:
    """planning/metrics.py per CONTRACT.md -> Metrics.

    frames are assembled Frames: each has t, detections (up to t per the
    contract note — but for metrics we need the state AT t, so frames carry
    the tracks/origins known at that t), origins, etc.
    """
    # ground truth lookups
    launch_by_drone = {tl["drone_id"]: tl for tl in raw.get("truth_launches", [])}

    origin_error_m_by_t: dict[str, float] = {}
    for mark in ERROR_T_MARKS:
        frame = _frame_at_or_before(frames, mark)
        if frame is None:
            continue
        errs = _origin_errors(frame, launch_by_drone)
        if errs:
            origin_error_m_by_t[str(mark)] = round(sum(errs) / len(errs), 1)

    track_rmse_m = _track_rmse(raw, frames)
    clutter_filtered_pct = _clutter_filtered_pct(raw, frames)

    return {
        "origin_error_m_by_t": origin_error_m_by_t,
        "track_rmse_m": round(track_rmse_m, 1) if track_rmse_m is not None else None,
        "clutter_filtered_pct": clutter_filtered_pct,
        "label": "Measured on simulated data",
    }


def _frame_at_or_before(frames: list[dict], t: int) -> dict | None:
    best = None
    for f in frames:
        if f.get("t", -1) <= t and (best is None or f.get("t", -1) > best.get("t", -1)):
            best = f
    return best


def _origin_errors(frame: dict, launch_by_drone: dict) -> list[float]:
    """Mean distance from each OriginEstimate peak to its drone's true launch point."""
    errors: list[float] = []
    tracks_by_id = {tr["id"]: tr for tr in frame.get("tracks", [])}
    for origin in frame.get("origins", []):
        track = tracks_by_id.get(origin.get("track_id"))
        if track is None:
            continue
        drone_id = track.get("truth_drone_id")
        # tracker may or may not carry truth on the track; fall back to a
        # detections lookup for this track's sensors at early t
        if not drone_id:
            drone_id = _drone_for_track(track, frame)
        launch = launch_by_drone.get(drone_id) if drone_id else None
        if launch is None:
            continue
        peak = origin.get("peak") or {}
        errors.append(math.hypot(peak.get("x", 0) - launch["x"], peak.get("y", 0) - launch["y"]))
    return errors


def _drone_for_track(track: dict, frame: dict) -> str | None:
    """Hackathon shortcut: associate via detections carrying truth_drone_id."""
    counts: dict[str, int] = {}
    for det in frame.get("detections", []):
        did = det.get("truth_drone_id")
        if did and det.get("sensor_id") in track.get("sensor_ids", []):
            counts[did] = counts.get(did, 0) + 1
    if not counts:
        return None
    return max(counts, key=counts.get)


def _track_rmse(raw: dict, frames: list[dict]) -> float | None:
    """RMSE of final track points vs truth_paths."""
    truth_by_t: dict[int, dict[str, dict]] = {}
    for drone_id, path in (raw.get("truth_paths") or {}).items():
        for p in path:
            truth_by_t.setdefault(int(p["t"]), {})[drone_id] = p

    last = None
    for f in frames:
        if last is None or f.get("t", -1) > last.get("t", -1):
            last = f
    if last is None:
        return None

    sq, n = 0.0, 0
    for track in last.get("tracks", []):
        drone_id = track.get("truth_drone_id") or _drone_for_track(
            track, {"detections": last.get("detections", [])}
        )
        if not drone_id:
            continue
        for point in track.get("points", []):
            truth = truth_by_t.get(int(point["t"]), {}).get(drone_id)
            if truth is None:
                continue
            sq += (point["x"] - truth["x"]) ** 2 + (point["y"] - truth["y"]) ** 2
            n += 1
    return math.sqrt(sq / n) if n else None


def _clutter_filtered_pct(raw: dict, frames: list[dict]) -> int:
    """Share of clutter detections that never contributed to a track.

    The tracker ignores clutter entirely, so the expected value is 100.
    We still compute it from the data: a clutter detection 'contributed'
    if a track point sits within 2*sigma of it at the same t.
    """
    total_clutter = 0
    contributed = 0

    track_points_by_t: dict[int, list[dict]] = {}
    for f in frames:
        for track in f.get("tracks", []):
            for point in track.get("points", []):
                track_points_by_t.setdefault(int(point["t"]), []).append(point)

    for f in frames:
        for det in f.get("detections", []):
            if not det.get("clutter"):
                continue
            total_clutter += 1
            sigma = det.get("sigma_m", 60) or 60
            for point in track_points_by_t.get(int(det["t"]), []):
                if math.hypot(point["x"] - det["x"], point["y"] - det["y"]) <= 2 * sigma:
                    contributed += 1
                    break

    if total_clutter == 0:
        return 100
    return round(100 * (total_clutter - contributed) / total_clutter)
