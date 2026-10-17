"""Exposure grid + friendly-route risk (Ali, planning/).

Semantics note: "the first 30% of the route's length" is measured from the
end of the route farthest from home_base — the contested end an enemy would
observe and trace back toward the route's origin. Diego's sim lists waypoints
home-first, so this is the last 30% of the listed waypoints; it is robust to
either waypoint order.
"""

import heapq
import math

CELL = 100
GRID_W = 100
GRID_H = 100

SAMPLE_STEP_M = 50.0
HEAD_START_FRAC = 0.30

RISK_LOW = 0.33
RISK_HIGH = 0.66

COST_EXPOSURE_WEIGHT = 20.0
RDP_EPSILON_M = 150.0
MAX_WAYPOINTS = 8


def _empty_grid() -> dict:
    return {
        "cell_m": CELL,
        "width": GRID_W,
        "height": GRID_H,
        "values": [[0.0] * GRID_W for _ in range(GRID_H)],
    }


def _exposure_at(x: float, y: float, enemy_sensors: list[dict]) -> float:
    e = 0.0
    for s in enemy_sensors:
        if not s.get("active", True):
            continue
        d = math.hypot(x - s["x"], y - s["y"])
        if d >= s["range_m"]:
            continue
        e = max(e, max(0.0, min(1.0, 1.0 - d / s["range_m"])) ** 0.7)
    return e


def _active_enemy_sensors(raw: dict) -> list[dict]:
    return [s for s in raw.get("sensors", []) if s.get("side") == "enemy" and s.get("active", True)]


def _polyline_length(points: list[tuple[float, float]]) -> float:
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:]))


def _cumulative(points: list[tuple[float, float]]) -> list[float]:
    cum = [0.0]
    for a, b in zip(points, points[1:]):
        cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return cum


def _point_at(points: list[tuple[float, float]], cum: list[float], dist: float) -> tuple[float, float]:
    if dist <= 0:
        return points[0]
    for i, c in enumerate(cum[1:], start=1):
        if dist <= c:
            a, b = points[i - 1], points[i]
            seg = c - cum[i - 1]
            frac = (dist - cum[i - 1]) / seg if seg > 0 else 0.0
            return a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac
    return points[-1]


def _orient_from_contested_end(points: list[tuple[float, float]], home: dict | None) -> list[tuple[float, float]]:
    """Return the polyline oriented so index 0 is the end farthest from home."""
    if home is None or len(points) < 2:
        return points
    d0 = math.hypot(points[0][0] - home["x"], points[0][1] - home["y"])
    d1 = math.hypot(points[-1][0] - home["x"], points[-1][1] - home["y"])
    return points if d0 >= d1 else list(reversed(points))


def path_risk(
    points: list[tuple[float, float]],
    sensors: list[dict],
    home: dict | None = None,
) -> tuple[float, list[str]]:
    """Mean exposure over the first 30% of the route measured from the contested
    end, sampled every 50 m. Also returns the sensors covering that window."""
    pts = _orient_from_contested_end(points, home)
    total = _polyline_length(pts)
    if total <= 0:
        e = _exposure_at(pts[0][0], pts[0][1], sensors) if pts else 0.0
        return e, [s["id"] for s in sensors if e > 0 and math.hypot(pts[0][0] - s["x"], pts[0][1] - s["y"]) < s["range_m"]]

    cum = _cumulative(pts)
    head = total * HEAD_START_FRAC
    samples: list[tuple[float, float]] = []
    d = 0.0
    while d < head:
        samples.append(_point_at(pts, cum, d))
        d += SAMPLE_STEP_M
    samples.append(_point_at(pts, cum, head))

    exposures = [_exposure_at(x, y, sensors) for x, y in samples]
    risk = sum(exposures) / len(exposures)

    exposed_by = sorted(
        s["id"]
        for s in sensors
        if any(math.hypot(x - s["x"], y - s["y"]) < s["range_m"] for x, y in samples)
    )
    return risk, exposed_by


def _risk_level(risk: float) -> str:
    if risk < RISK_LOW:
        return "low"
    if risk < RISK_HIGH:
        return "medium"
    return "high"


def run(raw: dict) -> tuple[dict, list[dict]]:
    """planning/exposure.py per CONTRACT.md -> (exposure_grid, routes)."""
    sensors = _active_enemy_sensors(raw)
    home = raw.get("home_base")

    grid = _empty_grid()
    for row in range(GRID_H):
        y = row * CELL + CELL / 2
        for col in range(GRID_W):
            x = col * CELL + CELL / 2
            grid["values"][row][col] = round(_exposure_at(x, y, sensors), 6)
    peak = max(max(r) for r in grid["values"])
    if peak > 1.0:
        grid["values"] = [[round(v / peak, 6) for v in r] for r in grid["values"]]

    routes = []
    for route in raw.get("friendly_routes", []):
        wps = [(w["x"], w["y"]) for w in route["waypoints"]]
        risk, exposed_by = path_risk(wps, sensors, home)
        out = {
            "id": route["id"],
            "waypoints": route["waypoints"],
            "risk": round(risk, 4),
            "risk_level": _risk_level(risk),
            "exposed_by": exposed_by,
            "safer_waypoints": None,
        }
        if risk > RISK_LOW:
            safer = _safer_path(wps, sensors)
        else:
            # still offer a safer corridor when one strictly improves on the route
            safer = _safer_path(wps, sensors) if risk > 0 else None
        if safer is not None:
            safer_risk, _ = path_risk(safer, sensors, home)
            if safer_risk < risk:
                out["safer_waypoints"] = [{"x": round(x, 1), "y": round(y, 1)} for x, y in safer]
        routes.append(out)
    return grid, routes


def _safer_path(waypoints: list[tuple[float, float]], sensors: list[dict]) -> list[tuple[float, float]] | None:
    """A* on the grid, cost = 1 + 20*exposure; RDP simplify to <= 8 waypoints."""
    start, goal = waypoints[0], waypoints[-1]

    def cell_of(p: tuple[float, float]) -> tuple[int, int]:
        return min(GRID_H - 1, max(0, int(p[1] // CELL))), min(GRID_W - 1, max(0, int(p[0] // CELL)))

    sc, sg = cell_of(start), cell_of(goal)
    if sc == sg:
        return None

    def center(cell: tuple[int, int]) -> tuple[float, float]:
        return cell[1] * CELL + CELL / 2, cell[0] * CELL + CELL / 2

    def h(cell: tuple[int, int]) -> float:
        cx, cy = center(cell)
        return math.hypot(cx - goal[0], cy - goal[1])

    open_heap = [(h(sc), sc)]
    came: dict[tuple[int, int], tuple[int, int] | None] = {sc: None}
    cost: dict[tuple[int, int], float] = {sc: 0.0}
    seen: set[tuple[int, int]] = set()

    while open_heap:
        _, cur = heapq.heappop(open_heap)
        if cur in seen:
            continue
        seen.add(cur)
        if cur == sg:
            break
        row, col = cur
        for drow in (-1, 0, 1):
            for dcol in (-1, 0, 1):
                if drow == 0 and dcol == 0:
                    continue
                nr, nc = row + drow, col + dcol
                if not (0 <= nr < GRID_H and 0 <= nc < GRID_W):
                    continue
                nxt = (nr, nc)
                if nxt in seen:
                    continue
                cx, cy = center(nxt)
                step = (CELL * math.sqrt(2) if drow and dcol else CELL) * (
                    1 + COST_EXPOSURE_WEIGHT * _exposure_at(cx, cy, sensors)
                )
                g = cost[cur] + step
                if g < cost.get(nxt, float("inf")):
                    cost[nxt] = g
                    came[nxt] = cur
                    heapq.heappush(open_heap, (g + h(nxt), nxt))

    if sg not in came:
        return None

    path: list[tuple[float, float]] = []
    node: tuple[int, int] | None = sg
    while node is not None:
        path.append(center(node))
        node = came[node]
    path.reverse()
    path[0], path[-1] = start, goal

    simplified = _rdp(path, RDP_EPSILON_M)
    simplified[0], simplified[-1] = start, goal
    if len(simplified) > MAX_WAYPOINTS:
        simplified = _downsample(simplified, MAX_WAYPOINTS)
    return simplified


def _rdp(points: list[tuple[float, float]], epsilon: float) -> list[tuple[float, float]]:
    if len(points) < 3:
        return list(points)
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi - lo < 2:
            continue
        ax, ay = points[lo]
        bx, by = points[hi]
        seg = math.hypot(bx - ax, by - ay) or 1.0
        dmax, imax = -1.0, -1
        for i in range(lo + 1, hi):
            px, py = points[i]
            d = abs((by - ay) * (px - ax) - (bx - ax) * (py - ay)) / seg
            if d > dmax:
                dmax, imax = d, i
        if dmax > epsilon:
            keep.add(imax)
            stack.append((lo, imax))
            stack.append((imax, hi))
    return [points[i] for i in sorted(keep)]


def _downsample(points: list[tuple[float, float]], n: int) -> list[tuple[float, float]]:
    idxs = [round(i * (len(points) - 1) / (n - 1)) for i in range(n)]
    return [points[i] for i in idxs]
