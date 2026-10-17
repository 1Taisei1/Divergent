"""Small fake RawScenario for testing analysis/ modules before sim/generate.py lands.

Shape matches CONTRACT.md -> sim/generate.py. All data is synthetic.

Layout: one launch team (LT1) launches E1 at t=0, moves ~1.2 km south, and launches E2 at t=30.
Both launch points sit just outside allied coverage; drones fly low and undetected for the first
10 s, then sensors pick them up. That matches the origin back-projection (speed x 10 s) in origin.py.
"""

import numpy as np

SEED = 1
DURATION_S = 60
SIGMA_M = 50.0
DETECT_PROB = 0.9
CLUTTER_FRACTION = 0.10
UNDETECTED_S = 10

SENSORS = [
    {"id": "S1", "side": "allied", "type": "radar", "x": 3500, "y": 4500, "range_m": 2000, "active": True},
    {"id": "S2", "side": "allied", "type": "acoustic", "x": 4200, "y": 2600, "range_m": 2000, "active": True},
    {"id": "S3", "side": "allied", "type": "rf", "x": 4000, "y": 1500, "range_m": 2000, "active": True},
]

# drone_id, team_id, launch t, launch x, launch y, vx, vy  (straight lines, ~25 m/s)
DRONES = [
    ("E1", "LT1", 0, 2000.0, 3000.0, 17.7, 17.7),
    ("E2", "LT1", 30, 1800.0, 1800.0, 24.8, -3.4),
]


def _in_range(sensor, x, y):
    return (x - sensor["x"]) ** 2 + (y - sensor["y"]) ** 2 <= sensor["range_m"] ** 2


def fake_raw():
    rng = np.random.default_rng(SEED)

    truth_paths = {}
    truth_launches = []
    raw_dets = []  # (t, sensor_id, x, y, clutter, truth_drone_id)

    for drone_id, team_id, t0, x0, y0, vx, vy in DRONES:
        truth_launches.append({"drone_id": drone_id, "team_id": team_id, "t": t0, "x": x0, "y": y0})
        path = []
        for t in range(t0, DURATION_S):
            x = x0 + vx * (t - t0)
            y = y0 + vy * (t - t0)
            path.append({"t": t, "x": round(x, 1), "y": round(y, 1)})
            if t - t0 < UNDETECTED_S:
                continue
            for s in SENSORS:
                if _in_range(s, x, y) and rng.random() < DETECT_PROB:
                    nx, ny = rng.normal(0.0, SIGMA_M, 2)
                    raw_dets.append((t, s["id"], x + nx, y + ny, False, drone_id))
        truth_paths[drone_id] = path

    # Clutter: enough false detections that they make up ~10% of the total, spread inside sensor coverage.
    n_true = len(raw_dets)
    n_clutter = round(n_true * CLUTTER_FRACTION / (1 - CLUTTER_FRACTION))
    for _ in range(n_clutter):
        s = SENSORS[rng.integers(len(SENSORS))]
        r = s["range_m"] * np.sqrt(rng.random())
        a = rng.uniform(0, 2 * np.pi)
        raw_dets.append((int(rng.integers(DURATION_S)), s["id"], s["x"] + r * np.cos(a), s["y"] + r * np.sin(a), True, None))

    raw_dets.sort(key=lambda d: (d[0], d[1]))
    detections_by_t = {t: [] for t in range(DURATION_S + 1)}  # t = 0..duration inclusive, like sim/generate.py
    for i, (t, sensor_id, x, y, clutter, drone_id) in enumerate(raw_dets):
        detections_by_t[t].append({
            "id": f"D-{i:06d}", "t": t, "sensor_id": sensor_id,
            "x": round(float(x), 1), "y": round(float(y), 1),
            "sigma_m": SIGMA_M, "clutter": clutter, "truth_drone_id": drone_id,
        })

    return {
        "id": "fake",
        "name": "Fake: one launch team, two drones, cluttered sensors",
        "seed": SEED,
        "map": {"width_m": 10000, "height_m": 10000, "cell_m": 100},
        "duration_s": DURATION_S,
        "sensors": [dict(s) for s in SENSORS],
        "detections_by_t": detections_by_t,
        "friendly_routes": [{"id": "F1", "waypoints": [{"x": 8000, "y": 1000}, {"x": 6000, "y": 3000}]}],
        "home_base": {"x": 8000, "y": 1000},
        "truth_paths": truth_paths,
        "truth_launches": truth_launches,
    }
