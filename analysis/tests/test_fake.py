import math

import numpy as np

from analysis.tests.fake import SENSORS, UNDETECTED_S, fake_raw


def _all_dets(raw):
    return [d for dets in raw["detections_by_t"].values() for d in dets]


def test_shape_and_determinism():
    raw = fake_raw()
    assert raw == fake_raw()
    assert sorted(raw["detections_by_t"]) == list(range(61))
    assert len([s for s in raw["sensors"] if s["side"] == "allied"]) == 3
    assert set(raw["truth_paths"]) == {"E1", "E2"}
    assert {l["team_id"] for l in raw["truth_launches"]} == {"LT1"}


def test_clutter_about_ten_percent():
    raw = fake_raw()
    dets = _all_dets(raw)
    clutter = [d for d in dets if d["clutter"]]
    assert 0.08 <= len(clutter) / len(dets) <= 0.12
    assert all(d["truth_drone_id"] is None for d in clutter)
    assert all(d["truth_drone_id"] in raw["truth_paths"] for d in dets if not d["clutter"])


def test_noise_and_coverage():
    raw = fake_raw()
    truth = {(k, p["t"]): p for k, path in raw["truth_paths"].items() for p in path}
    sensors = {s["id"]: s for s in SENSORS}
    errs = []
    for d in _all_dets(raw):
        if d["clutter"]:
            continue
        p = truth[(d["truth_drone_id"], d["t"])]
        errs += [d["x"] - p["x"], d["y"] - p["y"]]
        s = sensors[d["sensor_id"]]
        assert math.hypot(p["x"] - s["x"], p["y"] - s["y"]) <= s["range_m"]
    assert 40 <= np.std(errs) <= 60


def test_first_detection_ten_seconds_after_launch():
    raw = fake_raw()
    dets = [d for d in _all_dets(raw) if not d["clutter"]]
    for launch in raw["truth_launches"]:
        first_t = min(d["t"] for d in dets if d["truth_drone_id"] == launch["drone_id"])
        assert first_t == launch["t"] + UNDETECTED_S
