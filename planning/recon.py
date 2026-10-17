"""Recon route proposal + guarded flight (Ali, planning/).

Surveillance only: no payload, engagement, or targeting logic anywhere.
Nothing flies unless the route was approved by a named operator.
"""

import heapq
import math

import numpy as np

# The sim clip is 120 s, so the recon UAV has to be fast to reach a launch site and see it.
SPEED_MPS = 100.0
LOITER_S = 20

VALUE_W = 0.6
MAX_WAYPOINTS = 9
MAX_PATH_M = 20000.0
AVOID_EXPOSURE = 0.45   # planner never enters cells hotter than this; fly() auto-returns at 0.6
EXPOSURE_COST = 10.0
RDP_EPS_M = 200.0
CELL_M = 100

RISK_RETURN_THRESHOLD = 0.6

DETECT_RANGE_M = 1500.0  # also the range at which a launch site is pinpointed
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


def _arr(grid: dict, h: int = 100, w: int = 100) -> np.ndarray:
    v = (grid or {}).get("values")
    return np.array(v, dtype=float) if v else np.zeros((h, w))


def _dijkstra(exp: np.ndarray, src: tuple[int, int]):
    """8-neighbour shortest path on the grid; cost rises with exposure, hot cells are off limits."""
    h, w = exp.shape
    cost = np.full((h, w), np.inf)
    dist = np.zeros((h, w))
    prev: dict = {}
    cost[src] = 0.0
    pq = [(0.0, src)]
    while pq:
        c, (r, q) = heapq.heappop(pq)
        if c > cost[r, q]:
            continue
        for dr in (-1, 0, 1):
            for dq in (-1, 0, 1):
                nr, nq = r + dr, q + dq
                if (dr == 0 and dq == 0) or not (0 <= nr < h and 0 <= nq < w) or exp[nr, nq] > AVOID_EXPOSURE:
                    continue
                step = CELL_M * (1.4142 if dr and dq else 1.0)
                nc = c + step * (1 + EXPOSURE_COST * exp[nr, nq])
                if nc < cost[nr, nq]:
                    cost[nr, nq] = nc
                    dist[nr, nq] = dist[r, q] + step
                    prev[(nr, nq)] = (r, q)
                    heapq.heappush(pq, (nc, (nr, nq)))
    return cost, dist, prev


def _rdp(pts: list, eps: float) -> list:
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    seg = math.hypot(x2 - x1, y2 - y1) or 1e-9
    d, idx = max(((abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / seg, i)
                  for i, (x, y) in enumerate(pts[1:-1], 1)), default=(0, 0))
    if d <= eps:
        return [pts[0], pts[-1]]
    return _rdp(pts[: idx + 1], eps)[:-1] + _rdp(pts[idx:], eps)


def propose(raw: dict, frame: dict, exposure_grid: dict) -> dict:
    """ReconRoute (status proposed): fly to the reachable spot whose 1.5 km view covers the most
    forecast/origin heat, by the least exposed path, loiter, and come back the same way."""
    home = raw.get("home_base") or {"x": 0, "y": 0}
    home_xy = (home["x"], home["y"])
    t_now = int(frame.get("t", 0))
    exp = _arr(exposure_grid)
    h, w = exp.shape
    val = VALUE_W * _arr(frame.get("forecast_heatmap"), h, w) + (1 - VALUE_W) * _arr(frame.get("origin_heatmap"), h, w)

    # gain[r, c] = heat visible from that cell (disk of DETECT_RANGE_M)
    k = int(DETECT_RANGE_M // CELL_M)
    pad = np.pad(val, k)
    gain = np.zeros_like(val)
    for dr in range(-k, k + 1):
        for dc in range(-k, k + 1):
            if dr * dr + dc * dc <= k * k:
                gain += pad[k + dr:k + dr + h, k + dc:k + dc + w]

    src = (min(h - 1, int(home["y"] // CELL_M)), min(w - 1, int(home["x"] // CELL_M)))
    cost, dist, prev = _dijkstra(exp, src)
    time_left = int(raw.get("duration_s", 120)) - t_now - LOITER_S
    reach_m = min(max(time_left, 0) * SPEED_MPS, MAX_PATH_M / 2)
    ok = np.isfinite(cost) & (dist <= reach_m) & (dist > CELL_M)
    best = None
    if ok.any() and gain[ok].max() > 1e-6:
        top = gain[ok].max()
        good = ok & (gain >= 0.98 * top)
        best = tuple(np.unravel_index(np.argmin(np.where(good, cost, np.inf)), cost.shape))

    if best is None:
        waypoints = [{"x": home["x"], "y": home["y"]}]
        info_gain = 0.0
    else:
        cells, cur = [], best
        while cur != src:
            cells.append(cur)
            cur = prev[cur]
        cells.append(src)
        out = [home_xy] + [(c * CELL_M + CELL_M / 2, r * CELL_M + CELL_M / 2) for r, c in reversed(cells[:-1])]
        eps = RDP_EPS_M
        while True:
            simple = _rdp(out, eps)
            if 2 * len(simple) - 1 <= MAX_WAYPOINTS:
                break
            eps *= 1.5
        pts = simple + simple[-2::-1]  # out and back on the same low-exposure path
        waypoints = [{"x": round(float(x), 1), "y": round(float(y), 1)} for x, y in pts]
        info_gain = min(1.0, float(gain[best]) / max(float(val.sum()), 1e-9))

    risk = _mean_exposure_along([(q["x"], q["y"]) for q in waypoints], exposure_grid)
    return {
        "id": "R1",
        "waypoints": waypoints,
        "info_gain": round(info_gain, 4),
        "risk": round(risk, 4),
        "geofence": _geofence_of(waypoints),
        "status": "proposed",
        "approved_by": None,
        "approved_at": None,
        "log": [{"t": t_now, "event": "proposed"}],
    }


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

    apex = max(range(len(waypoints)), key=lambda i: math.hypot(waypoints[i][0] - home["x"], waypoints[i][1] - home["y"]))
    loiter_left = 0
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
        if not returning and loiter_left > 0:
            loiter_left -= 1  # hold over the target and watch
        elif not returning:
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
                    if leg_idx == apex and apex > 0:
                        loiter_left = LOITER_S
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


SITE_SIGMA_M = 25.0
SITE_RADIUS_M = 60.0


def sightings(raw: dict, recon_by_t: dict) -> list[dict]:
    """Launch sites the recon drone can see, one entry per second in view: {t, team_id, x, y, radius_m}.
    The camera sees a team's current site (its latest launch point) within DETECT_RANGE_M, with a
    fixed small position error per site. # ponytail: truth_launches stands in for the camera model."""
    launches = sorted(raw.get("truth_launches") or [], key=lambda l: l["t"])
    rng = np.random.default_rng(int(raw.get("seed", 0)) + 101)
    jitter: dict = {}
    out = []
    for t in sorted(recon_by_t):
        st = recon_by_t[t]
        current = {}
        for l in launches:
            if l["t"] <= t:
                current[l["team_id"]] = l
        for team, l in current.items():
            if math.hypot(st["x"] - l["x"], st["y"] - l["y"]) <= DETECT_RANGE_M:
                key = (team, l["x"], l["y"])
                if key not in jitter:
                    jitter[key] = rng.normal(0, SITE_SIGMA_M, 2)
                out.append({"t": t, "team_id": team, "x": round(l["x"] + float(jitter[key][0]), 1),
                            "y": round(l["y"] + float(jitter[key][1]), 1), "radius_m": SITE_RADIUS_M})
    return out
