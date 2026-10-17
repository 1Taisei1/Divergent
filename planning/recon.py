"""Recon route proposal + guarded flight (Ali, planning/).

Surveillance only: no payload, engagement, or targeting logic anywhere.
Nothing flies unless the route was approved by a named operator.
"""

import math

SPEED_MPS = 15.0

PICK_RADIUS_M = 1500.0
VALUE_W = 0.6
EXPOSURE_W = 1.5
MAX_WAYPOINTS = 6
MAX_PATH_M = 9000.0

RISK_RETURN_THRESHOLD = 0.6

DETECT_RANGE_M = 1000.0
DETECT_SIGMA_M = 30.0
RECON_SENSOR_ID = "R1"

GEOFENCE_PAD_M = 500.0


def _cell_of(x: float, y: float, cell_m: int) -> tuple[int, int]:
    return int(y // cell_m), int(x // cell_m)


def _cell_center(row: int, col: int, cell_m: int) -> tuple[float, float]:
    return col * cell_m + cell_m / 2, row * cell_m + cell_m / 2


def _grid_value(grid: dict, x: float, y: float) -> float:
    if not grid:
        return 0.0
    cell_m = grid.get("cell_m", 100)
    width, height = grid.get("width", 0), grid.get("height", 0)
    values = grid.get("values") or []
    row, col = _cell_of(x, y, cell_m)
    if 0 <= row < height and 0 <= col < width:
        return float(values[row][col])
    return 0.0


def _exposure_at(exposure_grid: dict, x: float, y: float) -> float:
    return _grid_value(exposure_grid, x, y)


def _geofence_of(waypoints: list[dict]) -> dict:
    xs = [w["x"] for w in waypoints]
    ys = [w["y"] for w in waypoints]
    return {
        "x_min": min(xs) - GEOFENCE_PAD_M,
        "x_max": max(xs) + GEOFENCE_PAD_M,
        "y_min": min(ys) - GEOFENCE_PAD_M,
        "y_max": max(ys) + GEOFENCE_PAD_M,
    }


def _in_geofence(fence: dict, x: float, y: float) -> bool:
    return fence["x_min"] <= x <= fence["x_max"] and fence["y_min"] <= y <= fence["y_max"]


def _clamp_to_geofence(fence: dict, x: float, y: float) -> tuple[float, float]:
    return (
        min(fence["x_max"], max(fence["x_min"], x)),
        min(fence["y_max"], max(fence["y_min"], y)),
    )


def _path_length(points: list[tuple[float, float]]) -> float:
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:]))


def _step_toward(pos, target, home_xy, total_len, exposure_grid):
    """Point up to PICK_RADIUS_M from pos toward target that leaves budget to fly home and stays below the
    auto-return risk; None if no such step of at least 100 m."""
    if target is None:
        return None
    dist = math.hypot(target[0] - pos[0], target[1] - pos[1])
    if dist < 1.0:
        return None
    step = min(PICK_RADIUS_M, dist)
    while step >= 100.0:
        x = pos[0] + (target[0] - pos[0]) * step / dist
        y = pos[1] + (target[1] - pos[1]) * step / dist
        if (total_len + step + math.hypot(x - home_xy[0], y - home_xy[1]) <= MAX_PATH_M
                and _exposure_at(exposure_grid, x, y) <= RISK_RETURN_THRESHOLD):
            return round(x, 1), round(y, 1)
        step -= 100.0
    return None


def propose(raw: dict, frame: dict, exposure_grid: dict) -> dict:
    """planning/recon.py propose per CONTRACT.md -> ReconRoute (status proposed)."""
    home = raw.get("home_base") or {"x": 0, "y": 0}
    forecast = frame.get("forecast_heatmap") or {}
    origin_heatmap = frame.get("origin_heatmap") or {}

    def value_at(x: float, y: float) -> float:
        return (
            VALUE_W * _grid_value(forecast, x, y)
            + (1 - VALUE_W) * _grid_value(origin_heatmap, x, y)
        )

    visited: list[tuple[float, float]] = [(home["x"], home["y"])]
    total_len = 0.0
    home_xy = (home["x"], home["y"])

    # highest-value cell on the whole map; used to head that way when nothing nearby has value
    cell_m = int((forecast or origin_heatmap).get("cell_m") or 100)
    target, target_value = None, 0.0
    for gy in range(cell_m // 2, 10000, cell_m):
        for gx in range(cell_m // 2, 10000, cell_m):
            v = value_at(gx, gy)
            if v > target_value:
                target, target_value = (gx, gy), v

    while len(visited) < MAX_WAYPOINTS and total_len < MAX_PATH_M:
        best = None
        best_score = -float("inf")
        for dx in range(-int(PICK_RADIUS_M), int(PICK_RADIUS_M) + 1, 100):
            for dy in range(-int(PICK_RADIUS_M), int(PICK_RADIUS_M) + 1, 100):
                if dx * dx + dy * dy > PICK_RADIUS_M * PICK_RADIUS_M:
                    continue
                x, y = visited[-1][0] + dx, visited[-1][1] + dy
                if not (0 <= x <= 10000 and 0 <= y <= 10000):
                    continue
                if any(math.hypot(x - vx, y - vy) < 1.0 for vx, vy in visited):
                    continue
                score = value_at(x, y) - EXPOSURE_W * _exposure_at(exposure_grid, x, y)
                if score > best_score:
                    best_score = score
                    best = (x, y)
        if best is None or best_score <= 0.0:
            # nothing nearby is worth visiting: step toward the best cell, as far as the path budget allows
            best = _step_toward(visited[-1], target, home_xy, total_len, exposure_grid)
            if best is None:
                break
        step = math.hypot(best[0] - visited[-1][0], best[1] - visited[-1][1])
        back = math.hypot(best[0] - home_xy[0], best[1] - home_xy[1])
        if total_len + step + back > MAX_PATH_M:
            break
        visited.append(best)
        total_len += step

    # return to home
    if visited[-1] != home_xy:
        visited.append(home_xy)

    # drop the home point if the loop never left it
    if len(visited) == 1:
        waypoints = [{"x": home["x"], "y": home["y"]}]
        visited_vals = [value_at(home["x"], home["y"])]
    else:
        waypoints = [{"x": round(x, 1), "y": round(y, 1)} for x, y in visited]
        visited_vals = [value_at(x, y) for x, y in visited]

    info_gain = sum(visited_vals) / len(visited_vals) if visited_vals else 0.0

    # risk = mean exposure along the path, sampled every 100 m
    pts = [(w["x"], w["y"]) for w in waypoints]
    risk = _mean_exposure_along(pts, exposure_grid)

    route = {
        "id": "R1",
        "waypoints": waypoints,
        "info_gain": round(info_gain, 4),
        "risk": round(risk, 4),
        "geofence": _geofence_of(waypoints),
        "status": "proposed",
        "approved_by": None,
        "approved_at": None,
        "log": [{"t": frame.get("t", 0), "event": "proposed"}],
    }
    return route


def _mean_exposure_along(points: list[tuple[float, float]], exposure_grid: dict, step_m: float = 100.0) -> float:
    if len(points) < 2:
        x, y = points[0]
        return _exposure_at(exposure_grid, x, y)
    cum = [0.0]
    for a, b in zip(points, points[1:]):
        cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = cum[-1]
    if total <= 0:
        return _exposure_at(exposure_grid, points[0][0], points[0][1])

    def point_at(dist: float) -> tuple[float, float]:
        for i, c in enumerate(cum[1:], start=1):
            if dist <= c:
                a, b = points[i - 1], points[i]
                seg = c - cum[i - 1]
                frac = (dist - cum[i - 1]) / seg if seg > 0 else 0.0
                return a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac
        return points[-1]

    samples = []
    d = 0.0
    while d < total:
        samples.append(point_at(d))
        d += step_m
    samples.append(point_at(total))
    vals = [_exposure_at(exposure_grid, x, y) for x, y in samples]
    return sum(vals) / len(vals)


def fly(
    raw: dict,
    route: dict,
    t_start: int,
    exposure_grid: dict,
    abort_t: int | None = None,
) -> tuple[dict, dict, list[dict]]:
    """planning/recon.py fly per CONTRACT.md.

    Returns (recon_by_t, detections_by_t, log) — the log carries every
    status change with t, including the pre-flight approve entry.
    Guardrails: refuses an unapproved route, stays inside the geofence,
    auto-returns home when risk_now > 0.6 or t >= abort_t.
    Surveillance only.
    """
    if route.get("status") != "approved" or not route.get("approved_by"):
        raise ValueError("route must be approved with a non-empty approved_by before flying")

    fence = route["geofence"]
    waypoints = [(w["x"], w["y"]) for w in route["waypoints"]]
    home = raw.get("home_base") or waypoints[0]

    recon_by_t: dict[int, dict] = {}
    detections_by_t: dict[int, list[dict]] = {}
    flight_log: list[dict] = list(route.get("log") or [])

    truth_by_t: dict[int, list[dict]] = {}
    for drone_id, path in (raw.get("truth_paths") or {}).items():
        for p in path:
            truth_by_t.setdefault(int(p["t"]), []).append({"id": drone_id, "x": p["x"], "y": p["y"]})

    duration = int(raw.get("duration_s", 120))
    det_seq = 0

    # walk the planned waypoints
    legs: list[tuple[tuple[float, float], tuple[float, float], float]] = []
    for a, b in zip(waypoints, waypoints[1:]):
        legs.append((a, b, math.hypot(b[0] - a[0], b[1] - a[1])))

    pos = waypoints[0]
    leg_idx = 0
    leg_dist = 0.0
    t = t_start
    status = "flying"
    flight_log.append({"t": t, "event": "flying", "by": route.get("approved_by")})
    returning = False
    return_legs: list[tuple[tuple[float, float], tuple[float, float], float]] | None = None
    return_idx = 0
    return_dist = 0.0

    while t <= duration and status not in ("returned", "aborted"):
        if not returning:
            if leg_idx >= len(legs):
                # finished the planned loop; head home
                returning = True
                flight_log.append({"t": t, "event": "returning"})
                return_legs = [((pos[0], pos[1]), (home["x"], home["y"]),
                                math.hypot(home["x"] - pos[0], home["y"] - pos[1]))]
                return_idx = 0
                return_dist = 0.0
            else:
                a, b, seg_len = legs[leg_idx]
                leg_dist += SPEED_MPS
                if leg_dist >= seg_len:
                    pos = b
                    leg_idx += 1
                    leg_dist = 0.0
                else:
                    frac = leg_dist / seg_len if seg_len > 0 else 0.0
                    pos = (a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac)
        else:
            if return_legs is None or return_idx >= len(return_legs):
                status = "returned"
                flight_log.append({"t": t, "event": "returned"})
                break
            a, b, seg_len = return_legs[return_idx]
            return_dist += SPEED_MPS
            if return_dist >= seg_len:  # also covers a zero-length leg (already home)
                pos = b
                return_idx += 1
                return_dist = 0.0
                if return_idx >= len(return_legs):
                    status = "returned"
                    flight_log.append({"t": t, "event": "returned"})
                    break
            elif seg_len > 0:
                frac = return_dist / seg_len
                pos = (a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac)

        # clamp inside geofence every step (guardrail)
        pos = _clamp_to_geofence(fence, pos[0], pos[1])

        risk_now = _exposure_at(exposure_grid, pos[0], pos[1])

        # auto return-to-home guardrail
        if not returning and risk_now > RISK_RETURN_THRESHOLD:
            returning = True
            flight_log.append({"t": t, "event": "auto_return", "risk_now": round(risk_now, 4)})
            return_legs = [((pos[0], pos[1]), (home["x"], home["y"]),
                            math.hypot(home["x"] - pos[0], home["y"] - pos[1]))]
            return_idx = 0
            return_dist = 0.0

        # abort guardrail
        if abort_t is not None and t >= abort_t and not returning:
            returning = True
            flight_log.append({"t": t, "event": "aborted"})
            return_legs = [((pos[0], pos[1]), (home["x"], home["y"]),
                            math.hypot(home["x"] - pos[0], home["y"] - pos[1]))]
            return_idx = 0
            return_dist = 0.0

        recon_by_t[t] = {
            "route_id": route["id"],
            "x": round(pos[0], 1),
            "y": round(pos[1], 1),
            "status": "returning" if returning else "flying",
            "risk_now": round(risk_now, 4),
        }

        # detections: enemy drones within 1000 m, one detection each second
        dets = []
        for drone in truth_by_t.get(t, []):
            if math.hypot(drone["x"] - pos[0], drone["y"] - pos[1]) <= DETECT_RANGE_M:
                det_seq += 1
                dets.append({
                    "id": f"D-{det_seq:06d}",
                    "t": t,
                    "sensor_id": RECON_SENSOR_ID,
                    "x": round(drone["x"], 1),
                    "y": round(drone["y"], 1),
                    "sigma_m": DETECT_SIGMA_M,
                    "clutter": False,
                    "truth_drone_id": drone["id"],
                })
        if dets:
            detections_by_t[t] = dets

        t += 1

    return recon_by_t, detections_by_t, flight_log
