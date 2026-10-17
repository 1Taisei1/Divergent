import math
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fake import fake_raw, ENEMY_SENSORS  # noqa: E402
from exposure import run, _exposure_at  # noqa: E402


def test_grid_shape_and_range():
    raw = fake_raw()
    grid, routes = run(raw)
    assert grid["width"] == 100 and grid["height"] == 100 and grid["cell_m"] == 100
    assert len(grid["values"]) == 100
    for row in grid["values"]:
        assert len(row) == 100
        for v in row:
            assert 0.0 <= v <= 1.0
    assert len(routes) == 2


def test_exposure_zero_outside_range():
    # point far from both enemy sensors
    assert _exposure_at(9000, 9000, ENEMY_SENSORS) == 0.0
    # point at a sensor's center is 1.0
    assert _exposure_at(2000, 7000, ENEMY_SENSORS) == 1.0


def test_route_keys_and_levels():
    raw = fake_raw()
    grid, routes = run(raw)
    by_id = {r["id"]: r for r in routes}
    for r in routes:
        assert set(r.keys()) == {"id", "waypoints", "risk", "risk_level", "exposed_by", "safer_waypoints"}
        assert r["risk_level"] in ("low", "medium", "high")
        assert 0.0 <= r["risk"] <= 1.0
    # F1 runs toward the enemy sensor area, F2 stays south-east
    assert by_id["F1"]["risk"] > by_id["F2"]["risk"]
    # F1 must have a safer alternative and it must be safer than F1
    safer = by_id["F1"]["safer_waypoints"]
    assert safer is not None and len(safer) <= 8
    from fake import HOME_BASE
    from exposure import path_risk
    safer_pts = [(w["x"], w["y"]) for w in safer]
    safer_risk, _ = path_risk(safer_pts, ENEMY_SENSORS, HOME_BASE)
    assert safer_risk < by_id["F1"]["risk"]
