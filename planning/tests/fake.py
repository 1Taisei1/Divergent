"""Fake input for planning/ tests, matching CONTRACT.md shapes.

Used until Diego's sim/generate.py lands (~12:00), then tests switch to
generate("demo").
"""

import math

MAP_W = 10000
MAP_H = 10000
CELL = 100
DURATION_S = 120

ENEMY_SENSORS = [
    {"id": "ES1", "side": "enemy", "type": "radar", "x": 2000, "y": 7000, "range_m": 2000, "active": True},
    {"id": "ES2", "side": "enemy", "type": "rf", "x": 4000, "y": 6000, "range_m": 2000, "active": True},
]

FRIENDLY_ROUTES = [
    {
        "id": "F1",
        "waypoints": [
            {"x": 8500, "y": 1000},
            {"x": 5000, "y": 6500},
        ],
    },
    {
        "id": "F2",
        "waypoints": [
            {"x": 8500, "y": 1000},
            {"x": 7500, "y": 4000},
        ],
    },
]

HOME_BASE = {"x": 8500, "y": 1000}


def _drone_path(drone_id: str, start: tuple[float, float], heading: tuple[float, float], speed: float, t_end: int):
    """Straight line path, one point per second."""
    norm = math.hypot(heading[0], heading[1])
    ux, uy = heading[0] / norm, heading[1] / norm
    return [
        {"t": t, "x": round(start[0] + ux * speed * t, 1), "y": round(start[1] + uy * speed * t, 1)}
        for t in range(0, t_end + 1)
    ]


def fake_raw() -> dict:
    """RawScenario per CONTRACT.md -> 'Python module interfaces'."""
    truth_paths = {
        "E1": _drone_path("E1", (1800, 7500), (7000, -3000), 30, DURATION_S),
        "E2": _drone_path("E2", (1500, 3000), (7500, 2000), 25, DURATION_S),
    }
    truth_launches = [
        {"drone_id": "E1", "team_id": "LT1", "t": 0, "x": 1800, "y": 7500},
        {"drone_id": "E2", "team_id": "LT2", "t": 0, "x": 1500, "y": 3000},
    ]
    return {
        "id": "fake",
        "name": "Fake scenario for planning tests",
        "seed": 42,
        "map": {"width_m": MAP_W, "height_m": MAP_H, "cell_m": CELL},
        "duration_s": DURATION_S,
        "sensors": list(ENEMY_SENSORS),
        "detections_by_t": {},
        "friendly_routes": FRIENDLY_ROUTES,
        "home_base": dict(HOME_BASE),
        "truth_paths": truth_paths,
        "truth_launches": truth_launches,
    }


def fake_forecast() -> dict:
    """Forecast Grid with a hotspot near (2500, 6500)."""
    grid = {
        "cell_m": CELL,
        "width": MAP_W // CELL,
        "height": MAP_H // CELL,
        "values": [[0.0] * (MAP_W // CELL) for _ in range(MAP_H // CELL)],
    }
    cx, cy = 2500, 6500
    sigma = 400.0
    for row in range(grid["height"]):
        for col in range(grid["width"]):
            x = col * CELL + CELL / 2
            y = row * CELL + CELL / 2
            grid["values"][row][col] = math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma))
    peak = max(max(row) for row in grid["values"])
    if peak > 0:
        grid["values"] = [[v / peak for v in row] for row in grid["values"]]
    return grid
