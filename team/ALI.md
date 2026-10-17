# ALI — task list
Folder: `planning/` only. Branch: `ali/*`. Start task 1 now.
Signatures are in CONTRACT.md → "Python module interfaces". Use your own fake input until Diego's `sim/generate.py` lands
(~12:00), then switch your tests to `generate("demo")`.

- [x] **1. Fake input.** `planning/tests/fake.py` → `fake_raw()`: enemy sensors ES1 (2000, 7000) and ES2 (4000, 6000), both
  range 2000 m; friendly routes F1 (8500, 1000)→(5000, 6500) and F2 (8500, 1000)→(7500, 4000); `home_base` (8500, 1000);
  plus `fake_forecast()` returning a Grid with a hotspot near (2500, 6500).

- [x] **2. `planning/exposure.py`** `run(raw) -> (exposure_grid, routes)`
  - Exposure per cell = max over active enemy sensors of `clip(1 − dist/range, 0, 1) ** 0.7`.
  - Route risk = mean exposure over the first 30% of the route's length (sample every 50 m). Set `risk_level` and
    `exposed_by` (enemy sensors covering that first 30%).
  - `safer_waypoints`: A* on the grid from start to end with cost = 1 + 20·exposure; simplify to ≤8 waypoints
    (Ramer–Douglas–Peucker, 150 m). Null if risk is low.
  - Tests: F1 risk > F2 risk, and the safer path for F1 has lower risk than F1.

- [x] **3. `planning/recon.py` → `propose(raw, frame, exposure_grid) -> ReconRoute`**
  - Value per cell = 0.6·forecast + 0.4·origin_heatmap (read from `frame`).
  - Greedy route from `home_base`: repeatedly pick the cell within 1500 m with the best value − 1.5·exposure that hasn't been
    visited, up to 6 waypoints, total path ≤ 9000 m, then return to `home_base`.
  - `geofence` = bounding box of the waypoints + 500 m. `info_gain` = mean value of the visited cells.
    `risk` = mean exposure along the path. `status` "proposed". `log` = [{t, "event": "proposed"}].

- [x] **4. `planning/recon.py` → `fly(raw, route, t_start, exposure_grid, abort_t=None) -> (recon_by_t, detections_by_t)`**
  - Requires `route["status"] == "approved"` and a non-empty `approved_by`; otherwise raise `ValueError`.
  - Move 15 m/s along the waypoints from `t_start`. Clamp the position inside `geofence` every step.
  - `risk_now` = exposure at the current cell. If `risk_now` > 0.6, or `t >= abort_t`, switch to returning straight to
    `home_base`; status `returned` on arrival. Log every status change with t.
  - Detections: each second, every enemy drone within 1000 m (from `raw["truth_paths"]`) gives a detection with
    `sensor_id "R1"`, sigma 30, `clutter false`.
  - Surveillance only: the module contains no payload, engagement, or targeting logic.
  - Tests: refuses an unapproved route; never leaves the geofence; abort returns home; high exposure triggers auto-return.

- [x] **5. `planning/metrics.py`** `run(raw, frames) -> Metrics`
  - `origin_error_m_by_t`: at t = 30, 60, 90, 120, the mean distance from each OriginEstimate peak to its drone's true launch
    point (match via track → `truth_drone_id` → `truth_launches`).
  - `track_rmse_m`: RMSE of final track points vs `truth_paths`. `clutter_filtered_pct`: share of clutter detections that
    never contributed to a track (should be 100 with the current tracker; still compute it).
  - `label`: "Measured on simulated data".

- [ ] **6. Flex (from about 2:15).** Ask Neil first, then Leo, what to take. Agree on which files move to you before you edit
  anything outside `planning/`.

- [ ] **7. Pitch deck (3:30).** Three slides: problem, how it works (with the metrics numbers), and the business (who buys it,
  software-only entry point, roadmap with real-data validation). Add a QR code to the Freestyle demo URL on the last slide.
