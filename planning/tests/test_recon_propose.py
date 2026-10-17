import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fake import fake_raw, fake_forecast, HOME_BASE  # noqa: E402
from recon import propose  # noqa: E402
from exposure import run as exposure_run  # noqa: E402


def _frame(t: int = 40) -> dict:
    return {
        "t": t,
        "forecast_heatmap": fake_forecast(),
        "origin_heatmap": fake_forecast(),
        "detections": [],
        "tracks": [],
        "origins": [],
        "launch_teams": [],
        "exposure_grid": {},
        "routes": [],
        "recon": None,
        "alerts": [],
    }


def test_route_shape_and_contract_keys():
    raw = fake_raw()
    eg, _routes = exposure_run(raw)
    route = propose(raw, _frame(), eg)
    assert set(route.keys()) == {
        "id", "waypoints", "info_gain", "risk", "geofence",
        "status", "approved_by", "approved_at", "log",
    }
    assert route["id"] == "R1"
    assert route["status"] == "proposed"
    assert route["approved_by"] is None and route["approved_at"] is None
    assert route["log"] == [{"t": 40, "event": "proposed"}]
    assert set(route["geofence"].keys()) == {"x_min", "x_max", "y_min", "y_max"}


def test_waypoint_and_path_budgets():
    raw = fake_raw()
    eg, _routes = exposure_run(raw)
    route = propose(raw, _frame(), eg)
    wps = route["waypoints"]
    assert 1 <= len(wps) <= 6
    pts = [(w["x"], w["y"]) for w in wps]
    total = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
    assert total <= 9000.0
    # route starts at home base
    assert pts[0] == (HOME_BASE["x"], HOME_BASE["y"])
    # ends back at home base when it left home
    if len(pts) > 1:
        assert pts[-1] == (HOME_BASE["x"], HOME_BASE["y"])


def test_geofence_covers_waypoints_plus_500():
    raw = fake_raw()
    eg, _routes = exposure_run(raw)
    route = propose(raw, _frame(), eg)
    fence = route["geofence"]
    for w in route["waypoints"]:
        assert fence["x_min"] <= w["x"] <= fence["x_max"]
        assert fence["y_min"] <= w["y"] <= fence["y_max"]
    xs = [w["x"] for w in route["waypoints"]]
    ys = [w["y"] for w in route["waypoints"]]
    assert fence["x_min"] == min(xs) - 500 and fence["x_max"] == max(xs) + 500
    assert fence["y_min"] == min(ys) - 500 and fence["y_max"] == max(ys) + 500
