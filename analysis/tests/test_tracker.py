import copy
import math

from analysis import tracker
from analysis.tests.fake import fake_raw


def _truth(raw):
    return {(k, p["t"]): p for k, path in raw["truth_paths"].items() for p in path}


def test_filtered_error_beats_raw_detections():
    raw = fake_raw()
    truth = _truth(raw)
    raw_errs = [
        math.hypot(d["x"] - truth[(d["truth_drone_id"], t)]["x"], d["y"] - truth[(d["truth_drone_id"], t)]["y"])
        for t, dets in raw["detections_by_t"].items() for d in dets if not d["clutter"]
    ]

    final = tracker.run(raw)[raw["duration_s"] - 1]
    drone_of = {"T1": "E1", "T2": "E2"}  # tracks are numbered in order of first detection
    track_errs = [
        math.hypot(p["x"] - truth[(drone_of[tr["id"]], p["t"])]["x"], p["y"] - truth[(drone_of[tr["id"]], p["t"])]["y"])
        for tr in final for p in tr["points"]
    ]
    assert len(final) == 2
    assert sum(track_errs) / len(track_errs) < sum(raw_errs) / len(raw_errs)


def test_clutter_is_never_used():
    raw = fake_raw()
    poisoned = copy.deepcopy(raw)
    for dets in poisoned["detections_by_t"].values():
        for d in dets:
            if d["clutter"]:  # even if clutter claims to belong to a drone, it must be skipped
                d.update(truth_drone_id="E1", sensor_id="S9", x=9900.0, y=9900.0)
    assert tracker.run(poisoned) == tracker.run(raw)


def test_track_goes_lost_and_freezes():
    raw = fake_raw()
    for t in range(31, raw["duration_s"]):
        raw["detections_by_t"][t] = [d for d in raw["detections_by_t"][t] if d["truth_drone_id"] != "E1"]
    tracks_by_t = tracker.run(raw)

    t1 = {t: next(tr for tr in tracks if tr["id"] == "T1") for t, tracks in tracks_by_t.items() if tracks}
    last = t1[59]["points"][-1]["t"]
    assert last <= 30
    assert t1[last + 4]["status"] == "active"
    assert t1[last + 5]["status"] == "lost"
    assert t1[last + 5] == t1[59]  # frozen, still reported


def test_track_fields():
    final = tracker.run(fake_raw())[59]
    t1 = next(tr for tr in final if tr["id"] == "T1")
    assert t1["sensor_ids"] == ["S1", "S2"]
    assert t1["points"][0]["t"] == 10
    assert t1["ellipse"]["major_m"] >= t1["ellipse"]["minor_m"] > 0
    assert 0 <= t1["ellipse"]["angle_deg"] < 180
    assert math.hypot(t1["current"]["vx"] - 17.7, t1["current"]["vy"] - 17.7) < 5
