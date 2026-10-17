"""Suggest where to add one allied sensor: the spot that covers the most launch-origin heat no sensor sees today.

run(raw, origin_heatmap_final, origins=None) -> SensorSuggestion | None  (see CONTRACT.md)

Mask the final origin heat map to the cells outside every active allied sensor's range, then try a candidate every
500 m and score it by the masked heat within 2000 m. `uncertainty_reduction` = best score / total masked heat.
Returns None when there is no uncovered heat (nothing to suggest). Scenario.sensor_suggestion is already nullable.

PROPOSAL for Diego (CONTRACT.md change, needs his OK): the contract signature `run(raw, origin_heatmap_final)` carries no
track ids, but `reason` should name the tracks that originate in the gap. This module adds an optional third argument,
`origins`: the final frame's list of OriginEstimate. The contract call `run(raw, grid)` still works; without `origins`
the reason says "where launch activity concentrates". Suggested contract line:
    run(raw, origin_heatmap_final: Grid, origins: list[OriginEstimate] | None = None) -> SensorSuggestion | None
"""

import math

import numpy as np

from analysis.grid import CELL_M, SIZE, cell_centers, from_grid

STEP_M = 500  # candidate spacing; candidates are STEP_M .. map size - STEP_M on both axes
SCORE_RADIUS_M = 2000  # heat within this distance of a candidate counts toward its score
ORIGIN_NEAR_M = 2000  # an origin peak this close to the candidate counts as "originating there"
COMPASS = ["east", "northeast", "north", "northwest", "west", "southwest", "south", "southeast"]


def _compass(dx, dy):
    """8-point compass word for the direction (dx east, dy north)."""
    angle = math.degrees(math.atan2(dy, dx)) % 360.0
    return COMPASS[int((angle + 22.5) // 45) % 8]


def _join(ids):
    return ids[0] if len(ids) == 1 else ", ".join(ids[:-1]) + " and " + ids[-1]


def _reason(x, y, allied, origins):
    gap = "the gap"
    if allied:
        s = min(allied, key=lambda s: math.hypot(s["x"] - x, s["y"] - y))
        dx, dy = x - s["x"], y - s["y"]
        gap += f" around {s['id']}" if math.hypot(dx, dy) < 1.0 else f" {_compass(dx, dy)} of {s['id']}"

    ids = []
    for o in origins or []:
        near = math.hypot(o["peak"]["x"] - x, o["peak"]["y"] - y) <= ORIGIN_NEAR_M
        if near and o["track_id"] not in ids:
            ids.append(o["track_id"])
    if not ids:
        return f"Covers {gap} where launch activity concentrates."
    return f"Covers {gap} where {_join(ids)} {'originates' if len(ids) == 1 else 'originate'}."


def run(raw, origin_heatmap_final, origins=None):
    heat = from_grid(origin_heatmap_final)
    X, Y = cell_centers()

    allied = [s for s in raw["sensors"] if s["side"] == "allied" and s["active"]]
    covered = np.zeros(heat.shape, dtype=bool)
    for s in allied:
        covered |= (X - s["x"]) ** 2 + (Y - s["y"]) ** 2 <= s["range_m"] ** 2
    masked = np.where(covered, 0.0, heat)

    total = float(masked.sum())
    if total <= 0:
        return None

    coords = np.arange(STEP_M, SIZE * CELL_M, STEP_M)
    scores = np.empty((len(coords), len(coords)))  # scores[iy][ix]: argmax then picks the first in row-major order
    for iy, cy in enumerate(coords):
        for ix, cx in enumerate(coords):
            scores[iy, ix] = masked[(X - cx) ** 2 + (Y - cy) ** 2 <= SCORE_RADIUS_M**2].sum()
    scores = np.round(scores, 9)  # float noise must not break exact ties
    iy, ix = np.unravel_index(np.argmax(scores), scores.shape)
    x, y = int(coords[ix]), int(coords[iy])

    return {
        "x": x,
        "y": y,
        "uncertainty_reduction": round(float(scores[iy, ix]) / total, 2),
        "reason": _reason(x, y, allied, origins),
    }
