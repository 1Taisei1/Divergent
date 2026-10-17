"""Forecast where each launch team will fire next: a heat map per second.

run(raw, launch_teams_by_t) -> {t: Grid}  (see CONTRACT.md)

The forecast center is the team's last origin plus the mean step between its origins, so a team
that keeps relocating is expected to relocate again. The blob widens the longer the team has been
quiet. Teams are summed and normalized; no teams gives an all-zero grid.
"""

import numpy as np

from analysis.grid import cell_centers, empty_grid, gaussian, to_grid

SIGMA0_M = 400.0
SIGMA_GROWTH_M_PER_S = 15.0
SIGMA_MAX_M = 2000.0


def _center(history):
    """Last origin plus the mean step between consecutive origins (zero step for a single origin)."""
    last = history[-1]
    if len(history) < 2:
        return last["x"], last["y"]
    n_steps = len(history) - 1
    dx = (last["x"] - history[0]["x"]) / n_steps
    dy = (last["y"] - history[0]["y"]) / n_steps
    return last["x"] + dx, last["y"] + dy


def _sigma(history, t):
    elapsed = max(0, t - history[-1]["t"])
    return min(SIGMA0_M + SIGMA_GROWTH_M_PER_S * elapsed, SIGMA_MAX_M)


def run(raw, launch_teams_by_t):
    X, Y = cell_centers()
    grids = {}

    for t in range(raw["duration_s"]):
        teams = launch_teams_by_t.get(t, [])
        if not teams:
            grids[t] = empty_grid()
            continue
        total = np.zeros_like(X)
        for team in teams:
            history = team["origin_history"]
            cx, cy = _center(history)
            total += gaussian(X, Y, cx, cy, _sigma(history, t))
        grids[t] = to_grid(total)

    return grids
