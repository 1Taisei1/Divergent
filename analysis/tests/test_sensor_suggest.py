import math

import numpy as np
import pytest

from analysis import sensor_suggest
from analysis.grid import cell_centers, empty_grid, gaussian, to_grid
from analysis.tests.fake import fake_raw

UNCOVERED = (1500, 6500)  # outside every fake sensor's range (S1 is 2.8 km away)
FAR_UNCOVERED = (8500, 8000)
COVERED = (4000, 3500)  # inside S1 and S2 coverage


def _blob(*blobs, sigma=300.0):
    """Hand-made origin heat map: sum of (x, y, amplitude) Gaussians, normalized by to_grid."""
    X, Y = cell_centers()
    return to_grid(sum(a * gaussian(X, Y, x, y, sigma) for x, y, a in blobs))


def _origin(track_id, x, y):
    return {"track_id": track_id, "peak": {"x": x, "y": y}, "confidence": 0.7, "radius_m": 400}


def _raw_with(sensors):
    raw = fake_raw()
    raw["sensors"] = sensors
    return raw


def _sensor(sid, x, y, range_m=2000, side="allied", active=True):
    return {"id": sid, "side": side, "type": "radar", "x": x, "y": y, "range_m": range_m, "active": active}


def test_suggestion_lands_on_uncovered_hotspot_not_the_covered_one():
    # The covered hotspot is the global maximum, but sensors already see it.
    grid = _blob((*COVERED, 1.0), (*UNCOVERED, 0.6), (*FAR_UNCOVERED, 0.3))
    s = sensor_suggest.run(fake_raw(), grid)

    assert set(s) == {"x", "y", "uncertainty_reduction", "reason"}
    assert type(s["x"]) is int and type(s["y"]) is int
    assert math.hypot(s["x"] - UNCOVERED[0], s["y"] - UNCOVERED[1]) < 1000
    assert 0 < s["uncertainty_reduction"] <= 1
    assert s["uncertainty_reduction"] == pytest.approx(0.6 / 0.9, abs=0.03)  # the 0.6 blob out of 0.6 + 0.3 uncovered


def test_reason_names_nearest_sensor_compass_and_nearby_tracks():
    grid = _blob((*UNCOVERED, 0.6), (*FAR_UNCOVERED, 0.3))
    origins = [_origin("T1", 1400, 6700), _origin("T3", 1900, 6200), _origin("T2", 8400, 8100)]
    s = sensor_suggest.run(fake_raw(), grid, origins)
    # S1 (3500, 4500) is the nearest allied sensor; the gap lies to its north-west.
    assert s["reason"] == "Covers the gap northwest of S1 where T1 and T3 originate."


def test_single_track_uses_singular_verb():
    grid = _blob((*UNCOVERED, 1.0))
    s = sensor_suggest.run(fake_raw(), grid, [_origin("T2", *UNCOVERED), _origin("T2", 1600, 6400)])
    assert s["reason"] == "Covers the gap northwest of S1 where T2 originates."


def test_reason_without_origins_or_with_none_nearby():
    grid = _blob((*UNCOVERED, 1.0))
    expected = "Covers the gap northwest of S1 where launch activity concentrates."
    assert sensor_suggest.run(fake_raw(), grid)["reason"] == expected  # contract call: run(raw, grid)
    assert sensor_suggest.run(fake_raw(), grid, None)["reason"] == expected
    assert sensor_suggest.run(fake_raw(), grid, [])["reason"] == expected
    assert sensor_suggest.run(fake_raw(), grid, [_origin("T2", 8400, 8100)])["reason"] == expected


def test_none_for_all_zero_grid():
    assert sensor_suggest.run(fake_raw(), empty_grid()) is None


def test_none_when_all_heat_is_inside_coverage():
    assert sensor_suggest.run(fake_raw(), _blob((*COVERED, 1.0), (4000, 2000, 0.8))) is None


def test_inactive_sensor_does_not_count_as_coverage():
    # (4000, 500) is covered by S3 only (S2 is 2.1 km away).
    grid = _blob((4000, 500, 1.0))
    assert sensor_suggest.run(fake_raw(), grid) is None

    raw = fake_raw()
    next(s for s in raw["sensors"] if s["id"] == "S3")["active"] = False
    s = sensor_suggest.run(raw, grid)
    assert s is not None
    assert math.hypot(s["x"] - 4000, s["y"] - 500) < 1000
    assert "S3" not in s["reason"]  # an inactive sensor is not named either: S2 is the nearest active one
    assert s["reason"] == "Covers the gap south of S2 where launch activity concentrates."


def test_enemy_sensors_do_not_count_as_coverage():
    raw = fake_raw()
    raw["sensors"].append(_sensor("ES1", *UNCOVERED, side="enemy"))
    s = sensor_suggest.run(raw, _blob((*UNCOVERED, 1.0)))
    assert s is not None
    assert math.hypot(s["x"] - UNCOVERED[0], s["y"] - UNCOVERED[1]) < 1000
    assert "ES1" not in s["reason"]


def test_ties_go_to_first_candidate_in_row_major_order():
    # One hot cell: every candidate within 2 km scores the same. Row-major = lowest y, then lowest x.
    values = np.zeros((100, 100))
    values[50, 50] = 1.0  # cell center (5050, 5050)
    s = sensor_suggest.run(_raw_with([]), to_grid(values))
    assert (s["x"], s["y"]) == (4000, 3500)
    assert s["uncertainty_reduction"] == 1.0


def test_no_allied_sensors_still_suggests():
    s = sensor_suggest.run(_raw_with([_sensor("ES1", 5000, 5000, side="enemy")]), _blob((*UNCOVERED, 1.0)))
    assert math.hypot(s["x"] - UNCOVERED[0], s["y"] - UNCOVERED[1]) < 1000
    assert s["reason"] == "Covers the gap where launch activity concentrates."


@pytest.mark.parametrize("hot, word", [
    ((7000, 5000), "east"), ((6500, 6500), "northeast"), ((5000, 7000), "north"), ((3500, 6500), "northwest"),
    ((3000, 5000), "west"), ((3500, 3500), "southwest"), ((5000, 3000), "south"), ((6500, 3500), "southeast"),
])
def test_compass_words(hot, word):
    # sigma 400 keeps a unique best candidate; a tighter blob is fully captured by many candidates (a tie, see above).
    raw =_raw_with([_sensor("S1", 5000, 5000, range_m=500)])
    s = sensor_suggest.run(raw, _blob((*hot, 1.0), sigma=400.0))
    assert (s["x"], s["y"]) == hot
    assert s["reason"] == f"Covers the gap {word} of S1 where launch activity concentrates."


def test_candidate_on_top_of_sensor_has_no_compass_word():
    raw = _raw_with([_sensor("S1", 5000, 5000, range_m=100)])
    s = sensor_suggest.run(raw, _blob((5000, 5000, 1.0), sigma=400.0))
    assert (s["x"], s["y"]) == (5000, 5000)
    assert s["reason"] == "Covers the gap around S1 where launch activity concentrates."
