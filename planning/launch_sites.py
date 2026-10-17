"""Friendly launch-site concealment (planning/).

The reverse of analysis/origin.py: the enemy finds where a drone launched by back-projecting from where its sensors
first saw it. A friendly launch is hard to trace when the site is outside enemy coverage, sits well back from the
edge of that coverage, and the first leg of flight crosses little exposure. Decision support only, simulated data.
"""

import math

import numpy as np

COVERAGE_EDGE = 0.2  # exposure at which a cell counts as "seen"
INSIDE_COVERAGE = 0.05  # sites above this exposure score 0
STANDOFF_FULL_M = 2000.0  # standoff at which the standoff term saturates
FIRST_LEG_M = 1500.0  # radius of the first leg a back-projection would use
MAX_FROM_HOME_M = 4000.0  # a team must be able to relocate there
MIN_SEPARATION_M = 1000.0
N_OPTIONS = 3


def _empty_grid(cell: int, w: int, h: int) -> dict:
    return {"cell_m": cell, "width": w, "height": h, "values": [[0.0] * w for _ in range(h)]}


def _standoff(exp: np.ndarray, cell: float) -> np.ndarray:
    """Distance (m) from each cell centre to the nearest cell with exposure >= COVERAGE_EDGE (inf if none)."""
    h, w = exp.shape
    rows, cols = np.nonzero(exp >= COVERAGE_EDGE)
    if rows.size == 0:
        return np.full((h, w), np.inf)
    cy, cx = rows.astype(float), cols.astype(float)
    out = np.empty((h, w))
    xs = np.arange(w, dtype=float)
    for r in range(h):  # one row at a time keeps memory at w x n_covered
        d2 = (xs[:, None] - cx[None, :]) ** 2 + (r - cy[None, :]) ** 2
        out[r] = np.sqrt(d2.min(axis=1)) * cell
    return out


def _disc_mean(exp: np.ndarray, radius_cells: int) -> np.ndarray:
    """Mean exposure within a disc around each cell, counting only cells inside the map."""
    h, w = exp.shape
    k = radius_cells
    yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
    kernel = (xx ** 2 + yy ** 2 <= k ** 2).astype(float)
    shape = (h + 2 * k, w + 2 * k)

    def conv(a):
        f = np.fft.rfft2(a, shape) * np.fft.rfft2(kernel, shape)
        return np.fft.irfft2(f, shape)[k:k + h, k:k + w]

    total = conv(exp)
    count = conv(np.ones_like(exp))
    return np.clip(total / np.maximum(count, 1e-9), 0.0, 1.0)


def _nearest_enemy(x: float, y: float, raw: dict) -> str | None:
    enemies = [s for s in raw.get("sensors", []) if s.get("side") == "enemy" and s.get("active", True)]
    if not enemies:
        return None
    return min(enemies, key=lambda s: math.hypot(s["x"] - x, s["y"] - y) - s["range_m"])["id"]


def _km(m: float) -> str:
    return f"{m / 1000:.1f} km"


def run(raw: dict, exposure_grid: dict) -> tuple[dict, list[dict]]:
    """-> (launch_site_grid, launch_site_options). Concealment per cell, 0..1 with max 1 (all zeros allowed)."""
    cell = float(exposure_grid.get("cell_m", 100))
    exp = np.asarray(exposure_grid.get("values") or [], dtype=float)
    if exp.ndim != 2 or exp.size == 0:
        return _empty_grid(int(cell), 100, 100), []
    h, w = exp.shape

    standoff = _standoff(exp, cell)
    s = np.clip(standoff / STANDOFF_FULL_M, 0.0, 1.0)
    local = _disc_mean(exp, int(round(FIRST_LEG_M / cell)))
    score = (1.0 - exp) * (0.5 * s + 0.5 * (1.0 - local))
    score[exp > INSIDE_COVERAGE] = 0.0
    peak = score.max()
    if peak > 0:
        score = score / peak
    score = np.round(score, 3)
    grid = {"cell_m": int(cell), "width": w, "height": h, "values": score.tolist()}

    home = raw.get("home_base") or {"x": w * cell / 2, "y": h * cell / 2}
    xs = (np.arange(w) + 0.5) * cell
    ys = (np.arange(h) + 0.5) * cell
    dist_home = np.hypot(xs[None, :] - home["x"], ys[:, None] - home["y"])

    # Rank by concealment; among equally hidden sites prefer the least relocation (closest to home).
    order = np.lexsort((dist_home.ravel(), -score.ravel()))
    options: list[dict] = []
    for idx in order:
        r, c = divmod(int(idx), w)
        if score[r, c] <= 0 or len(options) >= N_OPTIONS:
            break
        if dist_home[r, c] > MAX_FROM_HOME_M:
            continue
        x, y = float(xs[c]), float(ys[r])
        if any(math.hypot(o["x"] - x, o["y"] - y) < MIN_SEPARATION_M for o in options):
            continue
        sensor = _nearest_enemy(x, y, raw)
        gap = float(standoff[r, c])
        where = f"{_km(gap)} outside {sensor} coverage" if sensor and math.isfinite(gap) else "Outside all enemy coverage"
        leg = "unobserved" if local[r, c] < 0.01 else f"{round(local[r, c] * 100)}% exposed"
        options.append({
            "x": round(x), "y": round(y),
            "concealment": float(score[r, c]),
            "exposure_at_site": round(float(exp[r, c]), 3),
            "distance_to_coverage_m": round(gap) if math.isfinite(gap) else None,
            "nearest_enemy_sensor": sensor,
            "reason": f"{where}; the first {_km(FIRST_LEG_M)} of flight is {leg}.",
        })

    if options:
        hr = min(h - 1, max(0, int(home["y"] // cell)))
        hc = min(w - 1, max(0, int(home["x"] // cell)))
        home_score = float(score[hr, hc])
        if home_score < options[0]["concealment"]:
            options[0]["reason"] += f" Current home base scores {home_score:.2f}; this site scores {options[0]['concealment']:.2f}."
        else:
            options[0]["reason"] += f" Current home base already scores {home_score:.2f}."
    return grid, options
