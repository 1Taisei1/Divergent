import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fake import fake_raw, fake_forecast, HOME_BASE  # noqa: E402
from recon import propose, fly  # noqa: E402
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


def _approved_route():
    raw = fake_raw()
    eg, _routes = exposure_run(raw)
    route = propose(raw, _frame(), eg)
    route["status"] = "approved"
    route["approved_by"] = "operator"
    route["approved_at"] = 40
    route["log"].append({"t": 40, "event": "approved", "by": "operator"})
    return raw, eg, route


def test_refuses_unapproved_route():
    raw = fake_raw()
    eg, _routes = exposure_run(raw)
    route = propose(raw, _frame(), eg)
    for bad in (route, {**route, "status": "approved", "approved_by": None}):
        try:
            fly(raw, bad, 40, eg)
        except ValueError:
            continue
        raise AssertionError("fly must refuse an unapproved route")


def test_stays_inside_geofence():
    raw, eg, route = _approved_route()
    recon_by_t, _dets, log = fly(raw, route, 40, eg)
    fence = route["geofence"]
    assert recon_by_t, "no flight states produced"
    for st in recon_by_t.values():
        assert fence["x_min"] <= st["x"] <= fence["x_max"]
        assert fence["y_min"] <= st["y"] <= fence["y_max"]
        assert set(st.keys()) == {"route_id", "x", "y", "status", "risk_now"}


def test_flight_starts_and_ends_at_home():
    raw, eg, route = _approved_route()
    recon_by_t, _dets, log = fly(raw, route, 40, eg)
    ts = sorted(recon_by_t)
    first, last = recon_by_t[ts[0]], recon_by_t[ts[-1]]
    assert first["status"] in ("flying", "returning")
    # position at t_start is home (first step of 15 m/s along first leg)
    d0 = math.hypot(first["x"] - HOME_BASE["x"], first["y"] - HOME_BASE["y"])
    assert d0 <= 20.0
    assert last["status"] in ("flying", "returning", "returned")


def test_abort_returns_home():
    raw, eg, route = _approved_route()
    recon_by_t, _dets, log = fly(raw, route, 40, eg, abort_t=50)
    # after abort_t the drone must be on a straight line back to home
    fence = route["geofence"]
    ts = sorted(t for t in recon_by_t if t >= 50)
    assert ts, "no states after abort"
    for t in ts:
        st = recon_by_t[t]
        assert fence["x_min"] <= st["x"] <= fence["x_max"]
        assert fence["y_min"] <= st["y"] <= fence["y_max"]
    # distance to home must shrink over the return
    d_first = math.hypot(recon_by_t[ts[0]]["x"] - HOME_BASE["x"], recon_by_t[ts[0]]["y"] - HOME_BASE["y"])
    d_last = math.hypot(recon_by_t[ts[-1]]["x"] - HOME_BASE["x"], recon_by_t[ts[-1]]["y"] - HOME_BASE["y"])
    assert d_last < d_first
    # every state change is logged with a t
    events = [e["event"] for e in log]
    assert "approved" in events and "aborted" in events


def test_high_exposure_triggers_auto_return():
    raw, eg, route = _approved_route()
    raw["duration_s"] = 400  # give the flight time to get there and back
    # hot exposure pocket at the far end of the route: the drone gets
    # exposed mid-flight, far from home, and must turn back
    hot = {"cell_m": 100, "width": 100, "height": 100,
           "values": [[0.0] * 100 for _ in range(100)]}
    # build the route far from home so the return takes many steps
    route["waypoints"] = [
        {"x": HOME_BASE["x"], "y": HOME_BASE["y"]},
        {"x": 5200, "y": 4500},
        {"x": HOME_BASE["x"], "y": HOME_BASE["y"]},
    ]
    route["geofence"] = {
        "x_min": min(w["x"] for w in route["waypoints"]) - 500,
        "x_max": max(w["x"] for w in route["waypoints"]) + 500,
        "y_min": min(w["y"] for w in route["waypoints"]) - 500,
        "y_max": max(w["y"] for w in route["waypoints"]) + 500,
    }
    far = route["waypoints"][1]
    for row in range(100):
        for col in range(100):
            x, y = col * 100 + 50, row * 100 + 50
            d = math.hypot(x - far["x"], y - far["y"])
            if d < 1200:
                hot["values"][row][col] = 1.0
    recon_by_t, _dets, log = fly(raw, route, 40, hot)
    events = [e["event"] for e in log]
    assert "auto_return" in events
    ts = sorted(recon_by_t)
    assert len(ts) > 3, "auto return should take multiple steps from far away"
    # after the auto_return the drone heads home: distance shrinks
    auto_t = next(e["t"] for e in log if e["event"] == "auto_return")
    d_at_abort = math.hypot(recon_by_t[auto_t]["x"] - HOME_BASE["x"], recon_by_t[auto_t]["y"] - HOME_BASE["y"])
    d_last = math.hypot(recon_by_t[ts[-1]]["x"] - HOME_BASE["x"], recon_by_t[ts[-1]]["y"] - HOME_BASE["y"])
    assert d_last < d_at_abort
    # while in the hot pocket risk_now > 0.6
    assert any(st["risk_now"] > 0.6 for st in recon_by_t.values())


def test_detections_from_truth_paths():
    raw, eg, route = _approved_route()
    recon_by_t, dets_by_t, log = fly(raw, route, 40, eg)
    for t, dets in dets_by_t.items():
        assert recon_by_t[t]["x"] is not None
        for d in dets:
            assert d["sensor_id"] == "R1"
            assert d["sigma_m"] == 30
            assert d["clutter"] is False
            assert d["truth_drone_id"] is not None
            # within detection range of the drone's position at that t
            st = recon_by_t[t]
            assert math.hypot(d["x"] - st["x"], d["y"] - st["y"]) <= 1000.0 + 1e-6


def test_far_hotspot_still_leaves_home_within_budget():
    # value only far from home (beyond the 9000 m round trip): the route still heads that way and gets back
    raw = fake_raw()
    eg, _routes = exposure_run(raw)
    grid = {"cell_m": 100, "width": 100, "height": 100, "values": [[0.0] * 100 for _ in range(100)]}
    grid["values"][75][15] = 1.0  # ~(1550, 7550), ~9500 m from home
    frame = {**_frame(), "forecast_heatmap": grid, "origin_heatmap": grid}
    route = propose(raw, frame, eg)
    pts = [(w["x"], w["y"]) for w in route["waypoints"]]
    assert len(pts) >= 3 and pts[0] == pts[-1] == (HOME_BASE["x"], HOME_BASE["y"])
    path = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
    assert path <= 9000 + 1e-6


def test_route_that_never_leaves_home_ends_returned():
    raw = fake_raw()
    eg, _routes = exposure_run(raw)
    home = {"x": HOME_BASE["x"], "y": HOME_BASE["y"]}
    route = {"id": "R1", "waypoints": [home], "info_gain": 0, "risk": 0,
             "geofence": {"x_min": home["x"] - 500, "x_max": home["x"] + 500,
                          "y_min": home["y"] - 500, "y_max": home["y"] + 500},
             "status": "approved", "approved_by": "operator", "approved_at": 40,
             "log": [{"t": 40, "event": "approved", "by": "operator"}]}
    recon_by_t, _dets, log = fly(raw, route, 40, eg)
    assert log[-1]["event"] == "returned"
    assert max(recon_by_t) < 45
