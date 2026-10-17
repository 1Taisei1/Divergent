import json
import math

from analysis import origin, tracker
from analysis.grid import from_grid, peak_xy
from analysis.tests.fake import fake_raw

DRONE_OF = {"T1": "E1", "T2": "E2"}  # tracks are numbered in order of first detection


def _run():
    raw = fake_raw()
    tracks_by_t = tracker.run(raw)
    return raw, tracks_by_t, *origin.run(raw, tracks_by_t)


def test_peak_near_true_launch():
    raw, _, origins_by_t, _ = _run()
    launches = {l["drone_id"]: l for l in raw["truth_launches"]}
    final = origins_by_t[raw["duration_s"] - 1]
    assert {o["track_id"] for o in final} == {"T1", "T2"}
    for o in final:
        launch = launches[DRONE_OF[o["track_id"]]]
        assert math.hypot(o["peak"]["x"] - launch["x"], o["peak"]["y"] - launch["y"]) < 600


def test_needs_three_points_and_settles_after_five():
    raw, tracks_by_t, origins_by_t, _ = _run()
    t1_points = {t: len(tr["points"]) for t, trs in tracks_by_t.items() for tr in trs if tr["id"] == "T1"}
    has_origin = {t: any(o["track_id"] == "T1" for o in origins_by_t[t]) for t in t1_points}
    assert all(has_origin[t] == (n >= 3) for t, n in t1_points.items())

    t5 = min(t for t, n in t1_points.items() if n >= 5)
    settled = [next(o for o in origins_by_t[t] if o["track_id"] == "T1") for t in range(t5, raw["duration_s"])]
    assert all(o == settled[0] for o in settled)
    assert 0 < settled[0]["confidence"] <= 1


def test_output_is_json_serializable():
    _, _, origins_by_t, heatmap_by_t = _run()
    json.dumps([origins_by_t, heatmap_by_t[59]])


def test_heatmap():
    raw, _, origins_by_t, heatmap_by_t = _run()
    assert sorted(heatmap_by_t) == list(range(raw["duration_s"]))
    assert from_grid(heatmap_by_t[0]).max() == 0  # nothing tracked yet
    final = heatmap_by_t[raw["duration_s"] - 1]
    assert (final["width"], final["height"], final["cell_m"]) == (100, 100, 100)
    assert from_grid(final).max() == 1
    hx, hy = peak_xy(final)
    assert min(math.hypot(hx - o["peak"]["x"], hy - o["peak"]["y"]) for o in origins_by_t[raw["duration_s"] - 1]) < 300
