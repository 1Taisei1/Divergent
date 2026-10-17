"""Estimate where each track launched from, plus a heat map of likely launch areas.

run(raw, tracks_by_t) -> (origins_by_t, heatmap_by_t)  (see CONTRACT.md)

Back-projection: fit a velocity to a track's earliest points and step back from its first point by speed x BACK_S.
BACK_S is 0 because sim/generate.py detects drones from the moment they launch (measured on `demo`: mean origin error
43 m at 0 s vs 443 m at 10 s). Raise it if the sim adds an unseen climb-out after launch. The heat map still smears
SMEAR_BACK_S of flight behind the first point: the launch could be further back along the heading if detection was late.
The estimate settles once 5 points exist.

Triangulation (for drones first seen well after launch, e.g. the `dark` preset): one track only gives a direction back,
not a range, so on its own it stays below CONFIDENT confidence and its heat smears RAY_SMEAR_M back along the ray.
When the backward rays of 3+ drones pass close to one point (least squares), behind each first detection, within
MAX_UNSEEN_S of flight and with similar unseen distances, that point is their launch site: each drone's origin moves
there and confidence rises with every agreeing drone. Sites persist across frames (a launched drone's site never
changes). Drones seen from launch triangulate at the launch point too, so nothing changes for them.
"""

import math

import numpy as np

from analysis.grid import cell_centers, gaussian, to_grid

MIN_POINTS = 3
FIT_POINTS = 5
BACK_S = 0.0
SMEAR_BACK_S = 10.0
SMEAR_SIGMA_M = 100.0
SMEAR_WEIGHT = 0.3

RAY_FIT_POINTS = 30  # the heading needs a long baseline: 5 points (~150 m) leave tens of degrees of heading error
RAY_SMEAR_M = 2000.0  # how far back an untriangulated track's heat smears along its ray
MAX_UNSEEN_S = 90.0  # longest plausible unseen climb-out
AHEAD_TOL_M = 300.0  # a crossing may sit this far ahead of a first detection (noise)
MIN_SIN = 0.2  # rays closer than ~12 degrees are too parallel to cross reliably
SEED_PERP_M = 500.0  # rays passing this close to a crossing join its candidate site
PERP_TOL_M = 350.0  # after the least-squares fit, each member's ray must pass this close to the site
MIN_SUPPORT = 2  # crossings that must agree: 3 drones from one site
GAP_TOL_M = 700.0  # members of one site must have been unseen for a similar distance (a site seen at launch stays seen)
SINGLE_CAP = 0.6  # direction known, range unknown


def _clip(v, lo, hi):
    return max(lo, min(hi, v))


def _estimate(track, majors_by_t):
    pts = track["points"][:FIT_POINTS]
    ts = np.array([p["t"] for p in pts], dtype=float)
    vx = float(np.polyfit(ts, [p["x"] for p in pts], 1)[0])  # plain floats keep the output JSON-safe
    vy = float(np.polyfit(ts, [p["y"] for p in pts], 1)[0])
    first = pts[0]
    d = math.hypot(vx, vy) * BACK_S
    mean_major = float(np.mean([majors_by_t[p["t"]] for p in pts]))
    radius = 150 + 0.25 * d + mean_major
    confidence = _clip(len(pts) / FIT_POINTS, 0, 1) * _clip(1 - radius / 2000, 0.1, 1)
    estimate = {
        "track_id": track["id"],
        "peak": {"x": round(first["x"] - vx * BACK_S, 1), "y": round(first["y"] - vy * BACK_S, 1)},
        "confidence": round(confidence, 2),
        "radius_m": round(radius, 1),
    }
    # back-projection segment: from the peak to SMEAR_BACK_S of flight further behind it
    px, py = first["x"] - vx * BACK_S, first["y"] - vy * BACK_S
    segment = ((px, py), (px - vx * SMEAR_BACK_S, py - vy * SMEAR_BACK_S))
    return estimate, segment


def _ray(track):
    """(first point, unit backward heading, speed) from the earliest RAY_FIT_POINTS points."""
    pts = track["points"][:RAY_FIT_POINTS]
    ts = np.array([p["t"] for p in pts], dtype=float)
    vx = float(np.polyfit(ts, [p["x"] for p in pts], 1)[0])
    vy = float(np.polyfit(ts, [p["y"] for p in pts], 1)[0])
    speed = math.hypot(vx, vy)
    if speed < 1e-6:
        return None
    # anchor on the fitted line at the first time rather than the noisy first point
    t0 = ts[0]
    x0 = float(np.polyval(np.polyfit(ts, [p["x"] for p in pts], 1), t0))
    y0 = float(np.polyval(np.polyfit(ts, [p["y"] for p in pts], 1), t0))
    return (x0, y0), (-vx / speed, -vy / speed), speed


def _crossing(ri, rj):
    """Where two backward rays meet, if behind both first detections and within plausible unseen flight."""
    (pi, ui, si), (pj, uj, sj) = ri, rj
    det = ui[0] * (-uj[1]) - ui[1] * (-uj[0])
    if abs(det) < MIN_SIN:
        return None
    dx, dy = pj[0] - pi[0], pj[1] - pi[1]
    a = (dx * (-uj[1]) - dy * (-uj[0])) / det
    b = (ui[0] * dy - ui[1] * dx) / det
    if not (-AHEAD_TOL_M <= a <= si * MAX_UNSEEN_S and -AHEAD_TOL_M <= b <= sj * MAX_UNSEEN_S):
        return None
    return pi[0] + a * ui[0], pi[1] + a * ui[1]


def _triangulate(rays, sites=None):
    """track_id -> (x, y, n_agreeing_crossings, spread_m).

    A site is a group of >= MIN_SUPPORT + 1 drones whose backward rays all pass within PERP_TOL_M of one least-squares
    point, behind each drone's first detection, with similar unseen distances (GAP_TOL_M). Candidates are seeded at ray
    crossings; largest groups claim their drones first. `sites` (list of sets of track ids, updated in place) carries groups over
    from earlier frames: a launched drone's site never changes, so known sites keep their drones and only drones not
    yet placed can form new sites."""
    sites = [] if sites is None else sites
    placed = set().union(*sites) if sites else set()
    ids = sorted(d for d in rays if d not in placed)
    crossings = []
    for k, i in enumerate(ids):
        for j in ids[k + 1:]:
            c = _crossing(rays[i], rays[j])
            if c:
                crossings.append((i, j, c))
    def gap(d, c):  # how far back along d's ray the point sits
        (px, py), (ux, uy), _ = rays[d]
        return (c[0] - px) * ux + (c[1] - py) * uy

    def perp(d, c):  # how far d's ray passes from the point
        (px, py), (ux, uy), _ = rays[d]
        return abs((c[0] - px) * uy - (c[1] - py) * ux)

    def behind(d, c):
        return -AHEAD_TOL_M <= gap(d, c) <= rays[d][2] * MAX_UNSEEN_S

    # Every good crossing seeds a candidate site; any unplaced ray passing near it joins (rays need not cross pairwise).
    groups = []
    for _, _, seed in crossings:
        members = frozenset(d for d in ids if perp(d, seed) <= SEED_PERP_M and behind(d, seed))
        if len(members) > MIN_SUPPORT:
            groups.append((len(members), members))

    def lsq(members):
        """Point closest (least squares, perpendicular distance) to every member's ray."""
        A, b = np.zeros((2, 2)), np.zeros(2)
        for d in members:
            p, u, _ = rays[d]
            P = np.eye(2) - np.outer(u, u)
            A += P
            b += P @ np.array(p)
        return tuple(np.linalg.solve(A, b))

    out = {}

    def place(members, c):
        spread = float(np.sqrt(np.mean([perp(d, c) ** 2 for d in members])))
        for d in members:
            out[d] = (float(c[0]), float(c[1]), len(members) - 1, spread)

    for site in sites:  # known sites refit with whichever of their drones are still tracked
        members = {d for d in site if d in rays}
        if len(members) > MIN_SUPPORT:
            place(members, lsq(members))

    for _, members in sorted(set(groups), key=lambda g: (-g[0], sorted(g[1]))):
        members = set(members) - set(out)
        for _ in range(3):  # fit, drop rays that miss or don't fit the group's unseen distance, refit
            if len(members) <= MIN_SUPPORT:
                break
            c = lsq(members)
            gaps = {d: gap(d, c) for d in members}
            typical = float(np.median(list(gaps.values())))
            members = {d for d in members if perp(d, c) <= PERP_TOL_M and abs(gaps[d] - typical) <= GAP_TOL_M
                       and behind(d, c)}
        if len(members) <= MIN_SUPPORT:
            continue
        place(members, lsq(members))
        sites.append(set(members))
    return out


def _segment_dist(X, Y, a, b):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    s = np.zeros_like(X) if length2 == 0 else np.clip(((X - ax) * dx + (Y - ay) * dy) / length2, 0, 1)
    return np.hypot(X - (ax + s * dx), Y - (ay + s * dy))


def run(raw, tracks_by_t):
    X, Y = cell_centers()
    sites = []  # triangulated launch sites so far: sets of track ids
    majors = {}  # track_id -> {t: ellipse major_m}
    origins_by_t = {}
    heatmap_by_t = {}

    for t in range(raw["duration_s"] + 1):
        origins = []
        heat = np.zeros_like(X)
        ready = [tr for tr in tracks_by_t.get(t, []) if len(tr["points"]) >= MIN_POINTS]
        for track in tracks_by_t.get(t, []):
            majors.setdefault(track["id"], {})[t] = track["ellipse"]["major_m"]
        rays = {tr["id"]: r for tr in ready if (r := _ray(tr))}
        fixes = _triangulate(rays, sites)
        for track in ready:
            estimate, segment = _estimate(track, majors[track["id"]])
            fix = fixes.get(track["id"])
            if fix:
                fx, fy, n, spread = fix
                estimate["peak"] = {"x": round(fx, 1), "y": round(fy, 1)}
                estimate["radius_m"] = round(max(80.0, 2.0 * spread / math.sqrt(n + 1) + 300.0 / n), 1)
                estimate["confidence"] = round(_clip(SINGLE_CAP + 0.12 * n, 0, 0.95), 2)
                (px, py), _, _ = rays[track["id"]]
                segment = ((px, py), (fx, fy))  # the ray actually walked back to the fix
            else:
                estimate["confidence"] = min(estimate["confidence"], SINGLE_CAP)
                if track["id"] in rays:
                    (px, py), (ux, uy), _ = rays[track["id"]]
                    segment = ((px, py), (px + ux * RAY_SMEAR_M, py + uy * RAY_SMEAR_M))
            origins.append(estimate)
            heat += gaussian(X, Y, estimate["peak"]["x"], estimate["peak"]["y"], estimate["radius_m"])
            heat += SMEAR_WEIGHT * np.exp(-_segment_dist(X, Y, *segment) ** 2 / (2 * SMEAR_SIGMA_M**2))
        origins_by_t[t] = origins
        heatmap_by_t[t] = to_grid(heat)

    return origins_by_t, heatmap_by_t
