"""Estimate where each track launched from, plus a heat map of likely launch areas.

run(raw, tracks_by_t) -> (origins_by_t, heatmap_by_t)  (see CONTRACT.md)

Back-projection: fit a velocity to a track's earliest points and step back from its first point by speed x 10 s
(drones fly low and unseen for roughly their first 10 s). The estimate settles once 5 points exist.
"""

import math

import numpy as np

from analysis.grid import cell_centers, gaussian, to_grid

MIN_POINTS = 3
FIT_POINTS = 5
BACK_S = 10.0
SMEAR_SIGMA_M = 100.0
SMEAR_WEIGHT = 0.3


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
    # back-projection segment: from the first point to twice the projected distance behind it
    segment = ((first["x"], first["y"]), (first["x"] - 2 * vx * BACK_S, first["y"] - 2 * vy * BACK_S))
    return estimate, segment


def _segment_dist(X, Y, a, b):
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    s = np.zeros_like(X) if length2 == 0 else np.clip(((X - ax) * dx + (Y - ay) * dy) / length2, 0, 1)
    return np.hypot(X - (ax + s * dx), Y - (ay + s * dy))


def run(raw, tracks_by_t):
    X, Y = cell_centers()
    majors = {}  # track_id -> {t: ellipse major_m}
    origins_by_t = {}
    heatmap_by_t = {}

    for t in range(raw["duration_s"]):
        origins = []
        heat = np.zeros_like(X)
        for track in tracks_by_t.get(t, []):
            majors.setdefault(track["id"], {})[t] = track["ellipse"]["major_m"]
            if len(track["points"]) < MIN_POINTS:
                continue
            estimate, segment = _estimate(track, majors[track["id"]])
            origins.append(estimate)
            heat += gaussian(X, Y, estimate["peak"]["x"], estimate["peak"]["y"], estimate["radius_m"])
            heat += SMEAR_WEIGHT * np.exp(-_segment_dist(X, Y, *segment) ** 2 / (2 * SMEAR_SIGMA_M**2))
        origins_by_t[t] = origins
        heatmap_by_t[t] = to_grid(heat)

    return origins_by_t, heatmap_by_t
