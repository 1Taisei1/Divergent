from sim.generate import PRESETS, generate


def _all(raw):
    return [d for ds in raw["detections_by_t"].values() for d in ds]


def test_deterministic():
    assert generate("demo", 42) == generate("demo", 42)
    assert generate("demo", 42) != generate("demo", 7)


def test_clutter_fraction_and_range():
    raw = generate("demo")
    dets = _all(raw)
    sensors = {s["id"]: s for s in raw["sensors"]}
    clutter = [d for d in dets if d["clutter"]]
    assert 0.02 < len(clutter) / len(dets) < 0.25
    # per sensor per second ~8%
    active = sum(s["active"] for s in sensors.values() if s["side"] == "allied")
    assert abs(len(clutter) / (active * 121) - 0.08) < 0.03
    for d in dets:
        s = sensors[d["sensor_id"]]
        r = ((d["x"] - s["x"]) ** 2 + (d["y"] - s["y"]) ** 2) ** 0.5
        if d["clutter"]:
            assert d["truth_drone_id"] is None and r <= s["range_m"] + 1e-6
        else:
            # noise can push a reading slightly past range; allow 4 sigma
            assert r <= s["range_m"] + 4 * d["sigma_m"] * 2 ** 0.5


def test_overrides_and_presets():
    raw = generate("demo", overrides={"disable": ["S3"], "move": {"S1": [100, 100]}})
    s = {x["id"]: x for x in raw["sensors"]}
    assert not s["S3"]["active"] and (s["S1"]["x"], s["S1"]["y"]) == (100, 100)
    assert all(d["sensor_id"] != "S3" for d in _all(raw))
    for pid in PRESETS:
        assert generate(pid)["truth_launches"]
