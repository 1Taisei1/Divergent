"""Shared helpers for the 100 x 100 heat-map Grid in CONTRACT.md (100 m cells, values[row][col], row = y // 100)."""

import numpy as np

CELL_M = 100
SIZE = 100


def cell_centers():
    """(X, Y) arrays of shape (SIZE, SIZE): X[row][col], Y[row][col] are the cell-center coordinates in meters."""
    c = (np.arange(SIZE) + 0.5) * CELL_M
    return np.meshgrid(c, c)


def gaussian(X, Y, cx, cy, sigma):
    return np.exp(-((X - cx) ** 2 + (Y - cy) ** 2) / (2.0 * sigma**2))


def to_grid(arr):
    """Normalize so max = 1 (all zeros stays zeros) and wrap as a Grid dict."""
    arr = np.asarray(arr, dtype=float)
    peak = arr.max()
    if peak > 0:
        arr = arr / peak
    return {"cell_m": CELL_M, "width": SIZE, "height": SIZE, "values": np.round(arr, 3).tolist()}


def from_grid(grid):
    return np.asarray(grid["values"], dtype=float)


def empty_grid():
    return to_grid(np.zeros((SIZE, SIZE)))


def peak_xy(grid):
    """Cell-center (x, y) of the grid's maximum."""
    row, col = np.unravel_index(np.argmax(from_grid(grid)), (SIZE, SIZE))
    return (col + 0.5) * CELL_M, (row + 0.5) * CELL_M
