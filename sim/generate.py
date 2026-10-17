"""Synthetic scenario generator. Returns the RawScenario in CONTRACT.md. All data is simulated."""
import copy
import math

import numpy as np

MAP_M = 10000
SIGMA = {"radar": 40, "acoustic": 90, "rf": 140}
CLUTTER_P = 0.08

ALLIED = [
    ("S1", "radar", 2500, 3000, 2500),
    ("S2", "acoustic", 4500, 6500, 1500),
    ("S3", "rf", 5500, 2500, 3000),
    ("S4", "radar", 3500, 8500, 2500),
]
ENEMY = [("ES1", "radar", 2000, 8500, 2000), ("ES2", "radar", 6000, 5500, 2000)]

# team_id, launch-site waypoints [(from_t, (x, y))], launch times
DEMO_TEAMS = [
    ("LT1", [(0, (1800, 7500)), (60, (2600, 6800))], [5, 20, 35, 70, 85]),
    ("LT2", [(0, (1500, 3000))], [15, 50, 95]),
]

# "dark": RF-silent drones that climb out low and terrain-masked, so allied sensors first see them UNSEEN_S after launch,
# 1-1.6 km from the site. Radio-based tools have nothing to find; only the motion of the drones points back.
DARK_TEAMS = [
    ("LT1", [(0, (1600, 7200)), (45, (2500, 6300))], [5, 15, 30, 50, 58, 66]),
    ("LT2", [(0, (1300, 2700))], [10, 25, 45]),
]

PRESETS = {
    "demo": dict(name="Two launch teams, cluttered sensors", teams=DEMO_TEAMS),
    "single": dict(name="One team, one drone", teams=[("LT1", [(0, (1800, 7500))], [10])]),
    "swarm": dict(name="One team, six-drone swarm", teams=[("LT1", [(0, (1800, 7500))], [20] * 6)]),
    "sparse": dict(name="Two teams, only S1 and S4 active", teams=DEMO_TEAMS, disable=["S2", "S3"]),
    "dark": dict(name="Dark drones: RF-silent, launched out of sensor view", teams=DARK_TEAMS, unseen_s=40, rf_silent=True),
}

FRIENDLY_ROUTES = [
    {"id": "F1", "waypoints": [{"x": 8500, "y": 1000}, {"x": 5000, "y": 6500}]},
    {"id": "F2", "waypoints": [{"x": 8500, "y": 1000}, {"x": 7500, "y": 4000}]},
]


def _site_at(waypoints, t):
    pos = waypoints[0][1]
    for from_t, p in waypoints:
        if t >= from_t:
            pos = p
    return pos


def _in_range(s, x, y):
    return math.hypot(x - s["x"], y - s["y"]) <= s["range_m"]


def generate(scenario_id: str, seed: int = 42, overrides: dict | None = None) -> dict:
    preset = PRESETS[scenario_id]
    overrides = overrides or {}
    rng = np.random.default_rng(seed)
    duration = 120

    sensors = [
        {"id": i, "side": "allied", "type": ty, "x": x, "y": y, "range_m": r, "active": True}
        for i, ty, x, y, r in ALLIED
    ] + [
        {"id": i, "side": "enemy", "type": ty, "x": x, "y": y, "range_m": r, "active": True}
        for i, ty, x, y, r in ENEMY
    ]
    for s in sensors:
        if s["id"] in preset.get("disable", []) or s["id"] in overrides.get("disable", []):
            s["active"] = False
        if s["id"] in overrides.get("move", {}):
            s["x"], s["y"] = overrides["move"][s["id"]]

    # drones: straight line toward a random point in the east half
    drones, truth_launches, n = [], [], 0
    for team_id, sites, launch_ts in preset["teams"]:
        for lt in launch_ts:
            n += 1
            sx, sy = _site_at(sites, lt)
            tx, ty = rng.uniform(MAP_M / 2, MAP_M), rng.uniform(0, MAP_M)
            speed = rng.uniform(25, 40)
            d = math.hypot(tx - sx, ty - sy)
            drones.append(dict(id=f"E{n}", t0=lt, x0=sx, y0=sy,
                               vx=(tx - sx) / d * speed, vy=(ty - sy) / d * speed))
            truth_launches.append({"drone_id": f"E{n}", "team_id": team_id, "t": lt, "x": sx, "y": sy})

    truth_paths = {d["id"]: [] for d in drones}
    detections_by_t, did = {}, 0
    allied_active = [s for s in sensors if s["side"] == "allied" and s["active"]]
    unseen_s = preset.get("unseen_s", 0)
    rf_silent = preset.get("rf_silent", False)
    for t in range(duration + 1):
        dets = []
        for d in drones:
            if t < d["t0"]:
                continue
            x, y = d["x0"] + d["vx"] * (t - d["t0"]), d["y0"] + d["vy"] * (t - d["t0"])
            if not (0 <= x <= MAP_M and 0 <= y <= MAP_M):
                continue
            truth_paths[d["id"]].append({"t": t, "x": x, "y": y})
            if t - d["t0"] < unseen_s:  # masked climb-out: no sensor sees it yet
                continue
            for s in allied_active:
                if rf_silent and s["type"] == "rf":
                    continue
                if _in_range(s, x, y):
                    sg = SIGMA[s["type"]]
                    did += 1
                    dets.append({"id": f"D-{did:06d}", "t": t, "sensor_id": s["id"],
                                 "x": float(x + rng.normal(0, sg)), "y": float(y + rng.normal(0, sg)),
                                 "sigma_m": sg, "clutter": False, "truth_drone_id": d["id"]})
        for s in allied_active:
            if rng.random() < CLUTTER_P:
                ang, rad = rng.uniform(0, 2 * math.pi), s["range_m"] * math.sqrt(rng.random())
                did += 1
                dets.append({"id": f"D-{did:06d}", "t": t, "sensor_id": s["id"],
                             "x": s["x"] + rad * math.cos(ang), "y": s["y"] + rad * math.sin(ang),
                             "sigma_m": SIGMA[s["type"]], "clutter": True, "truth_drone_id": None})
        detections_by_t[t] = dets

    return {
        "id": scenario_id, "name": preset["name"], "seed": seed,
        "map": {"width_m": MAP_M, "height_m": MAP_M, "cell_m": 100},
        "duration_s": duration, "sensors": sensors,
        "detections_by_t": detections_by_t,
        "friendly_routes": copy.deepcopy(FRIENDLY_ROUTES),
        "home_base": {"x": 8500, "y": 1000},
        "truth_paths": truth_paths, "truth_launches": truth_launches,
    }
