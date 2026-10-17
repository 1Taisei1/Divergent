import math
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fake import fake_raw, ENEMY_SENSORS, HOME_BASE  # noqa: E402
from exposure import run as exposure_run  # noqa: E402
from launch_sites import run, MAX_FROM_HOME_M, MIN_SEPARATION_M  # noqa: E402


def _cell(grid, x, y):
    return grid["values"][int(y // grid["cell_m"])][int(x // grid["cell_m"])]


def _run(raw):
    exposure_grid, _ = exposure_run(raw)
    return exposure_grid, run(raw, exposure_grid)


def test_grid_shape_and_range():
    _, (grid, options) = _run(fake_raw())
    assert grid["width"] == 100 and grid["height"] == 100 and grid["cell_m"] == 100
    vals = [v for row in grid["values"] for v in row]
    assert all(0.0 <= v <= 1.0 for v in vals)
    assert max(vals) == 1.0
    assert options


def test_zero_at_enemy_sensors():
    _, (grid, _) = _run(fake_raw())
    for s in ENEMY_SENSORS:
        assert _cell(grid, s["x"], s["y"]) == 0.0


def test_options_hidden_reachable_and_spread():
    exposure_grid, (_, options) = _run(fake_raw())
    assert 1 <= len(options) <= 3
    for o in options:
        assert o["exposure_at_site"] <= 0.05
        assert _cell(exposure_grid, o["x"], o["y"]) <= 0.05
        assert math.hypot(o["x"] - HOME_BASE["x"], o["y"] - HOME_BASE["y"]) <= MAX_FROM_HOME_M
        assert o["reason"]
    for i, a in enumerate(options):
        for b in options[i + 1:]:
            assert math.hypot(a["x"] - b["x"], a["y"] - b["y"]) >= MIN_SEPARATION_M


def test_best_option_beats_a_home_near_the_enemy():
    raw = fake_raw()
    raw["home_base"] = {"x": 5200, "y": 4300}  # just outside ES2's coverage
    _, (grid, options) = _run(raw)
    home_score = _cell(grid, 5200, 4300)
    assert options[0]["concealment"] > home_score
    assert "Current home base scores" in options[0]["reason"]


def test_no_enemy_sensors_means_no_exposure_anywhere():
    raw = fake_raw()
    raw["sensors"] = [s for s in raw["sensors"] if s["side"] != "enemy"]
    _, (grid, options) = _run(raw)
    assert all(v == 1.0 for row in grid["values"] for v in row)
    assert options[0]["distance_to_coverage_m"] is None


def test_deterministic():
    raw = fake_raw()
    assert _run(raw)[1] == _run(raw)[1]
