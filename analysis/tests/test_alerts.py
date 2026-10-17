"""Alerts: small hand-made frames, no other module involved."""

import pytest

from analysis import alerts


def frame(t, **kw):
    return {"t": t, **kw}


def track(tid, status="active", sensors=("S1",), vx=0.0, vy=0.0):
    return {"id": tid, "status": status, "sensor_ids": list(sensors), "points": [],
            "current": {"x": 0.0, "y": 0.0, "vx": vx, "vy": vy}, "ellipse": {"major_m": 100, "minor_m": 50, "angle_deg": 0}}


def origin(tid, confidence, x=1800.0, y=3600.0):
    return {"track_id": tid, "peak": {"x": x, "y": y}, "confidence": confidence, "radius_m": 450}


def team(tid, points, track_ids=("T1",)):
    return {"id": tid, "origin_history": [{"t": t, "x": x, "y": y} for t, x, y in points], "track_ids": list(track_ids)}


def route(rid, level, risk=0.7, exposed_by=("ES2",)):
    return {"id": rid, "waypoints": [], "risk": risk, "risk_level": level, "exposed_by": list(exposed_by),
            "safer_waypoints": None}


def recon(status, risk_now, rid="R1"):
    return {"route_id": rid, "x": 7000, "y": 2000, "status": status, "risk_now": risk_now}


def kinds(by_t, t=None):
    items = by_t[t] if t is not None else [a for lst in by_t.values() for a in lst]
    return [a["kind"] for a in items]


def only(by_t, kind):
    found = [a for lst in by_t.values() for a in lst if a["kind"] == kind]
    assert len(found) == 1, found
    return found[0]


def test_empty_input_and_empty_frames():
    assert alerts.run([]) == {}
    out = alerts.run([frame(0), frame(1, tracks=[], origins=None, launch_teams=[], routes=None, recon=None)])
    assert out == {0: [], 1: []}


def test_every_frame_t_has_an_entry_and_alert_shape():
    frames = [frame(t, tracks=[track("T1")] if t >= 2 else []) for t in range(5)]
    out = alerts.run(frames)
    assert sorted(out) == [0, 1, 2, 3, 4]
    a = only(out, "new_track")
    assert set(a) == {"t", "kind", "message", "recommended_action", "ref_id"}


def test_new_track_once_with_sensors_and_action():
    frames = [
        frame(0),
        frame(1, tracks=[track("T3", sensors=["S2", "S4"])]),
        frame(2, tracks=[track("T3", sensors=["S2", "S4", "S5"])]),
        frame(3, tracks=[track("T3", sensors=["S2", "S4", "S5"])]),
    ]
    out = alerts.run(frames)
    a = only(out, "new_track")
    assert a == {"t": 1, "kind": "new_track", "message": "New track T3 detected by S2 and S4.",
                 "recommended_action": "Monitor T3; origin estimate pending.", "ref_id": "T3"}
    assert out[0] == [] and out[2] == [] and out[3] == []


def test_new_track_names_one_and_three_sensors():
    out = alerts.run([frame(0, tracks=[track("T1", sensors=["S1"]), track("T2", sensors=["S1", "S2", "S3"])])])
    msgs = [a["message"] for a in out[0]]
    assert msgs == ["New track T1 detected by S1.", "New track T2 detected by S1, S2 and S3."]


def test_track_lost_once_names_sensors_and_heading():
    frames = [
        frame(0, tracks=[track("T1", sensors=["S1", "S3"], vx=10, vy=0)]),
        frame(1, tracks=[track("T1", sensors=["S1", "S3"], vx=10, vy=0)]),
        frame(2, tracks=[track("T1", status="lost", sensors=["S1", "S3"], vx=10, vy=0)]),
        frame(3, tracks=[track("T1", status="lost", sensors=["S1", "S3"], vx=10, vy=0)]),
    ]
    out = alerts.run(frames)
    a = only(out, "track_lost")
    assert a["t"] == 2 and a["ref_id"] == "T1"
    assert "T1" in a["message"] and "S1 and S3" in a["message"]
    assert a["recommended_action"] == "Last seen heading east; watch for re-detection."
    assert kinds(out, 3) == []


@pytest.mark.parametrize("vx,vy,word", [
    (0, 5, "north"), (4, 4, "north-east"), (7, 0, "east"), (3, -3, "south-east"),
    (0, -2, "south"), (-5, -5, "south-west"), (-9, 0, "west"), (-1, 1, "north-west"),
    (10, 3, "east"), (3, 10, "north"), (-10, -2, "west"),
])
def test_compass_heading(vx, vy, word):
    out = alerts.run([frame(0, tracks=[track("T1", status="lost", vx=vx, vy=vy)])])
    a = only(out, "track_lost")
    assert a["recommended_action"] == f"Last seen heading {word}; watch for re-detection."


def test_lost_track_that_returns_and_is_lost_again_alerts_twice():
    frames = [
        frame(0, tracks=[track("T1", vx=1, vy=0)]),
        frame(1, tracks=[track("T1", status="lost", vx=1, vy=0)]),
        frame(2, tracks=[track("T1", status="lost", vx=1, vy=0)]),
        frame(3, tracks=[track("T1", vx=0, vy=1)]),
        frame(4, tracks=[track("T1", status="lost", vx=0, vy=1)]),
    ]
    out = alerts.run(frames)
    lost = [a for lst in out.values() for a in lst if a["kind"] == "track_lost"]
    assert [a["t"] for a in lost] == [1, 4]
    assert lost[1]["recommended_action"].startswith("Last seen heading north;")


def test_origin_confident_fires_once_at_threshold():
    frames = [
        frame(0, origins=[origin("T2", 0.30)]),
        frame(1, origins=[origin("T2", 0.69)]),
        frame(2, origins=[origin("T2", 0.72, x=1804.0, y=3596.0)]),
        frame(3, origins=[origin("T2", 0.90)]),
        frame(4, origins=[origin("T2", 0.50)]),
        frame(5, origins=[origin("T2", 0.95)]),
    ]
    out = alerts.run(frames)
    a = only(out, "origin_confident")
    assert a["t"] == 2 and a["ref_id"] == "T2"
    assert "T2" in a["message"] and "(1800, 3600)" in a["message"] and "72%" in a["message"]
    assert a["recommended_action"] == "Launch area located; consider a survey."


def test_origin_confident_exactly_point_seven_and_per_track():
    out = alerts.run([frame(0, origins=[origin("T1", 0.7), origin("T2", 0.2)]),
                      frame(1, origins=[origin("T1", 0.8), origin("T2", 0.71)])])
    got = [(a["t"], a["ref_id"]) for lst in out.values() for a in lst if a["kind"] == "origin_confident"]
    assert got == [(0, "T1"), (1, "T2")]


def test_launch_team_moved_on_each_longer_history():
    p1 = (20, 0.0, 0.0)
    p2 = (75, 600.0, 800.0)  # 1000 m from p1
    p3 = (110, 600.0, 2300.0)  # 1500 m from p2
    frames = [
        frame(0, launch_teams=[team("LT1", [p1], ["T1"])]),
        frame(1, launch_teams=[team("LT1", [p1, p2], ["T1", "T3"])]),
        frame(2, launch_teams=[team("LT1", [p1, p2], ["T1", "T3"])]),
        frame(3, launch_teams=[team("LT1", [p1, p2, p3], ["T1", "T3"])]),
        frame(4, launch_teams=[team("LT1", [p1, p2, p3], ["T1", "T3"])]),
    ]
    out = alerts.run(frames)
    moved = [a for lst in out.values() for a in lst if a["kind"] == "launch_team_moved"]
    assert [a["t"] for a in moved] == [1, 3]
    assert all(a["ref_id"] == "LT1" for a in moved)
    assert all(a["recommended_action"] == "Team relocated; expect launches near the forecast zone." for a in moved)
    assert "LT1" in moved[0]["message"] and "1.0 km" in moved[0]["message"] and "T1 and T3" in moved[0]["message"]
    assert "1.5 km" in moved[1]["message"]


def test_launch_team_with_one_point_never_alerts():
    out = alerts.run([frame(t, launch_teams=[team("LT1", [(20, 0, 0)])]) for t in range(3)])
    assert kinds(out) == []


def test_launch_team_tracked_separately():
    a, b = (10, 0.0, 0.0), (50, 3000.0, 4000.0)
    out = alerts.run([frame(0, launch_teams=[team("LT1", [a, b]), team("LT2", [a])]),
                      frame(1, launch_teams=[team("LT1", [a, b]), team("LT2", [a, b])])])
    moved = [(x["t"], x["ref_id"]) for lst in out.values() for x in lst if x["kind"] == "launch_team_moved"]
    assert moved == [(0, "LT1"), (1, "LT2")]
    assert "5.0 km" in out[0][0]["message"]


def test_route_exposed_once_when_first_high():
    frames = [
        frame(0, routes=[route("F1", "low", 0.1, [])]),
        frame(1, routes=[route("F1", "medium", 0.5)]),
        frame(2, routes=[route("F1", "high", 0.64, ["ES2", "ES3"])]),
        frame(3, routes=[route("F1", "high", 0.70, ["ES2", "ES3"])]),
        frame(4, routes=[route("F1", "medium", 0.5)]),
        frame(5, routes=[route("F1", "high", 0.66, ["ES2"])]),
    ]
    out = alerts.run(frames)
    a = only(out, "route_exposed")
    assert a["t"] == 2 and a["ref_id"] == "F1"
    assert "F1" in a["message"] and "64%" in a["message"] and "ES2 and ES3" in a["message"]
    assert a["recommended_action"] == "Use the safer corridor for F1."


def test_recon_auto_return_when_risk_exceeded_0_6():
    frames = [
        frame(0),
        frame(1, recon=recon("flying", 0.2)),
        frame(2, recon=recon("flying", 0.72)),
        frame(3, recon=recon("flying", 0.4)),
        frame(4, recon=recon("returned", 0.3)),
        frame(5, recon=recon("returned", 0.1)),
        frame(6, recon=None),
    ]
    out = alerts.run(frames)
    a = only(out, "recon_auto_return")
    assert a["t"] == 4 and a["ref_id"] == "R1"
    assert "R1" in a["message"] and "72%" in a["message"]
    assert a["recommended_action"] == "Survey aborted for safety; replan."


def test_recon_returning_without_high_risk_does_not_alert():
    frames = [frame(1, recon=recon("flying", 0.2)), frame(2, recon=recon("flying", 0.6)),
              frame(3, recon=recon("returned", 0.1)), frame(4, recon=recon("returned", 0.1))]
    assert kinds(alerts.run(frames)) == []


def test_recon_high_risk_while_still_flying_does_not_alert():
    assert kinds(alerts.run([frame(1, recon=recon("flying", 0.9)), frame(2, recon=recon("flying", 0.2))])) == []


def test_recon_risk_is_tracked_per_route():
    frames = [frame(1, recon=recon("flying", 0.9, "R1")), frame(2, recon=recon("returned", 0.1, "R2"))]
    assert kinds(alerts.run(frames)) == []


def test_no_launch_forecast_and_kinds_in_contract():
    frames = [
        frame(0, tracks=[track("T1")], origins=[origin("T1", 0.9)], routes=[route("F1", "high")]),
        frame(1, tracks=[track("T1", status="lost", vx=1, vy=1)],
              launch_teams=[team("LT1", [(0, 0, 0), (10, 100, 100)])], recon=recon("returned", 0.8)),
    ]
    out = alerts.run(frames)
    allowed = {"new_track", "track_lost", "origin_confident", "launch_team_moved", "route_exposed", "recon_auto_return"}
    assert set(kinds(out)) <= allowed
    assert all(a["t"] == t for t, lst in out.items() for a in lst)


def test_kind_order_within_a_frame_and_unsorted_input():
    busy = frame(5, tracks=[track("T1", status="lost", vx=1, vy=0)], origins=[origin("T1", 0.9)],
                 launch_teams=[team("LT1", [(0, 0, 0), (10, 500, 0)])], routes=[route("F1", "high")],
                 recon=recon("returned", 0.9))
    out = alerts.run([busy, frame(1, tracks=[track("T1")])])  # out of order on purpose
    assert kinds(out, 1) == ["new_track"]
    assert kinds(out, 5) == ["track_lost", "origin_confident", "launch_team_moved", "route_exposed", "recon_auto_return"]
