"""Fuse raw detections into tracks: one constant-velocity Kalman filter per drone.

run(raw) -> {t: [Track]}  (see CONTRACT.md)

Hackathon shortcut: detections are associated by `truth_drone_id`. Clutter is never used.
Ellipse `angle_deg` is the major axis direction, counter-clockwise from east (+x), in [0, 180).
"""

import math

import numpy as np
from filterpy.common import Q_discrete_white_noise
from filterpy.kalman import KalmanFilter

LOST_AFTER_S = 5
ACCEL_VAR = 1.0  # process noise, (m/s^2)^2: drones fly near-straight lines
INIT_POS_STD = 1000.0  # loose prior so the first detections set the position
INIT_VEL_STD = 40.0  # velocity unknown at first sight; drones fly ~10-40 m/s


def _new_filter(det):
    kf = KalmanFilter(dim_x=4, dim_z=2)  # state [x, y, vx, vy]
    kf.F = np.array([[1, 0, 1, 0], [0, 1, 0, 1], [0, 0, 1, 0], [0, 0, 0, 1]], dtype=float)
    kf.H = np.array([[1, 0, 0, 0], [0, 1, 0, 0]], dtype=float)
    kf.Q = Q_discrete_white_noise(dim=2, dt=1.0, var=ACCEL_VAR, block_size=2, order_by_dim=False)
    kf.x = np.array([det["x"], det["y"], 0.0, 0.0])
    kf.P = np.diag([INIT_POS_STD**2, INIT_POS_STD**2, INIT_VEL_STD**2, INIT_VEL_STD**2])
    return kf


def _ellipse(P):
    vals, vecs = np.linalg.eigh(P[:2, :2])  # ascending eigenvalues
    major = vecs[:, 1]
    return {
        "major_m": round(2 * math.sqrt(max(vals[1], 0.0)), 1),
        "minor_m": round(2 * math.sqrt(max(vals[0], 0.0)), 1),
        "angle_deg": round(math.degrees(math.atan2(major[1], major[0])) % 180.0, 1),
    }


def _snapshot(tr, t):
    x, y, vx, vy = (float(v) for v in tr["kf"].x)
    return {
        "id": tr["id"],
        "status": "lost" if t - tr["last_det_t"] >= LOST_AFTER_S else "active",
        "sensor_ids": sorted(tr["sensor_ids"]),
        "points": list(tr["points"]),
        "current": {"x": round(x, 1), "y": round(y, 1), "vx": round(vx, 2), "vy": round(vy, 2)},
        "ellipse": _ellipse(tr["kf"].P),
    }


def run(raw):
    tracks = {}  # drone_id -> {id, kf, t (filter time), last_det_t, sensor_ids, points}
    tracks_by_t = {}

    for t in range(raw["duration_s"]):
        by_drone = {}
        for d in raw["detections_by_t"].get(t, []):
            if d["clutter"] or d["truth_drone_id"] is None:
                continue
            by_drone.setdefault(d["truth_drone_id"], []).append(d)

        for drone_id in sorted(by_drone):
            if drone_id not in tracks:
                tracks[drone_id] = {
                    "id": f"T{len(tracks) + 1}", "kf": _new_filter(by_drone[drone_id][0]),
                    "t": t, "last_det_t": t, "sensor_ids": set(), "points": [],
                }

        for drone_id, tr in tracks.items():
            dets = by_drone.get(drone_id, [])
            if not dets and t - tr["last_det_t"] >= LOST_AFTER_S:
                continue  # lost: frozen until the drone is detected again
            while tr["t"] < t:  # predict up to now (more than one step after a lost gap)
                tr["kf"].predict()
                tr["t"] += 1
            for d in dets:
                tr["kf"].update([d["x"], d["y"]], R=d["sigma_m"] ** 2)
                tr["sensor_ids"].add(d["sensor_id"])
            if dets:
                tr["last_det_t"] = t
                tr["points"].append({"t": t, "x": round(float(tr["kf"].x[0]), 1), "y": round(float(tr["kf"].x[1]), 1)})

        tracks_by_t[t] = [_snapshot(tr, t) for tr in tracks.values()]

    return tracks_by_t
