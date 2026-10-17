import numpy as np
import pytest

from analysis import forecast
from analysis.grid import from_grid, peak_xy

RAW = {"duration_s": 200}


def _team(*points, team_id="LT1"):
    """LaunchTeam from (t, x, y) origin points."""
    return {
        "id": team_id,
        "origin_history": [{"t": t, "x": x, "y": y} for t, x, y in points],
        "track_ids": ["T1"],
    }


def _area(grid, level=0.5):
    return int((from_grid(grid) >= level).sum())


def test_peak_shifts_in_move_direction():
    before = _team((20, 3000, 5000))
    after = _team((20, 3000, 5000), (75, 4000, 5000))
    teams_by_t = {t: [before] for t in range(20, 75)} | {t: [after] for t in range(75, 200)}
    grids = forecast.run(RAW, teams_by_t)

    x0, y0 = peak_xy(grids[74])
    x1, y1 = peak_xy(grids[75])
    assert abs(x0 - 3000) <= 100 and abs(y0 - 5000) <= 100  # no step yet: forecast sits on the origin
    assert x1 > 4000  # east of the latest origin, along the move
    assert abs(x1 - 5000) <= 100 and abs(y1 - 5000) <= 100  # last origin + the (1000, 0) step
    assert x1 > x0 and abs(y1 - y0) <= 100


@pytest.mark.parametrize("move", [(-800, 0), (0, 900), (700, -600), (-500, -500)])
def test_peak_follows_any_move_direction(move):
    dx, dy = move
    start = (5000, 5000)
    team = _team((10, *start), (60, start[0] + dx, start[1] + dy))
    grids = forecast.run(RAW, {60: [team]})

    px, py = peak_xy(grids[60])
    last = (start[0] + dx, start[1] + dy)
    assert (px - last[0]) * dx + (py - last[1]) * dy > 0  # past the latest origin, in the direction of travel
    assert abs(px - (last[0] + dx)) <= 100 and abs(py - (last[1] + dy)) <= 100


def test_center_uses_mean_step_over_all_history():
    team = _team((10, 1000, 4000), (40, 2000, 4000), (70, 4000, 4000))  # mean step = (4000-1000)/2 = 1500
    px, py = peak_xy(forecast.run(RAW, {70: [team]})[70])
    assert abs(px - 5500) <= 100 and abs(py - 4000) <= 100


def test_single_origin_has_zero_step():
    team = _team((30, 6200, 2300))
    px, py = peak_xy(forecast.run(RAW, {30: [team]})[30])
    assert abs(px - 6200) <= 100 and abs(py - 2300) <= 100


def test_grid_for_every_second_and_zeros_without_teams():
    grids = forecast.run(RAW, {50: [_team((20, 3000, 5000))]})
    assert sorted(grids) == list(range(RAW["duration_s"]))
    for t, g in grids.items():
        assert (g["cell_m"], g["width"], g["height"]) == (100, 100, 100)
        assert from_grid(g).shape == (100, 100)
        if t != 50:
            assert not from_grid(g).any()
    assert forecast.run(RAW, {}) == forecast.run(RAW, {7: []})  # absent and empty both mean no teams


def test_max_is_one_with_teams():
    teams = [_team((20, 3000, 5000)), _team((30, 7000, 2000), (80, 7500, 2400), team_id="LT2")]
    g = forecast.run(RAW, {90: teams})[90]
    assert from_grid(g).max() == 1.0
    assert from_grid(g).min() >= 0.0


def test_two_teams_give_two_hot_spots():
    far_apart = [_team((20, 2000, 2000)), _team((20, 8000, 8000), team_id="LT2")]
    v = from_grid(forecast.run(RAW, {20: far_apart})[20])
    assert v[20, 20] > 0.95 and v[80, 80] > 0.95  # row = y // 100, col = x // 100
    assert v[50, 50] < 0.01


def test_sigma_grows_with_time_since_last_launch():
    team = _team((20, 5050, 5050))  # a cell center, so cell [50, 60] is exactly 1000 m east of it
    grids = forecast.run(RAW, {t: [team] for t in range(20, 200)})
    areas = [_area(grids[t]) for t in (20, 40, 60, 80)]
    assert areas == sorted(areas) and len(set(areas)) == len(areas)  # the hot area keeps widening

    # sigma = 400 + 15 * 40 = 1000 m at t = 60: a cell 1000 m from the center sits at exp(-1/2)
    assert from_grid(grids[60])[50, 60] == pytest.approx(np.exp(-0.5), abs=2e-3)
    assert from_grid(grids[20])[50, 60] == pytest.approx(np.exp(-1e6 / (2 * 400**2)), abs=2e-3)


def test_sigma_caps_at_2000_m():
    team = _team((20, 5050, 5050))
    grids = forecast.run({"duration_s": 400}, {t: [team] for t in range(20, 400)})
    # 400 + 15 * 107 = 2005 > 2000, so everything from t = 127 on is identical
    assert grids[127] == grids[200] == grids[399]
    assert grids[126] != grids[127]  # sigma was still 1990 m one second earlier
    assert from_grid(grids[399])[50, 60] == pytest.approx(np.exp(-1e6 / (2 * 2000**2)), abs=2e-3)


def test_time_before_last_launch_does_not_shrink_sigma():
    team = _team((50, 5000, 5000))
    at_launch = forecast.run(RAW, {50: [team]})[50]
    early = forecast.run(RAW, {10: [team]})[10]  # elapsed would be negative; clamps to 0
    assert early == at_launch
