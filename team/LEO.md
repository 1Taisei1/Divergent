# LEO — task list
Folder: `analysis/` only. Branch: `leo/*`. Start task 1 now.
Signatures are in CONTRACT.md → "Python module interfaces". Use your own fake input until Diego's `sim/generate.py` lands
(~12:00), then switch your tests to `generate("demo")`.

- [ ] **1. Fake input.** `analysis/tests/fake.py` → `fake_raw()` returning a RawScenario: 3 allied sensors, 2 drones on straight
  lines over 60 s, noise sigma 50 m, about 10% clutter, `truth_paths`, `truth_launches`. Seed 1.

- [ ] **2. `analysis/tracker.py`** `run(raw) -> {t: [Track]}`
  - One 4-state constant-velocity Kalman filter (filterpy `KalmanFilter`, dt=1) per `truth_drone_id`; skip `clutter`.
  - Each second: predict, then update with every detection for that drone, using R = sigma_m².
  - `sensor_ids` = every sensor that has contributed so far. `points` = filtered positions so far.
  - `ellipse` from the 2x2 position covariance: eigenvalues → `major_m`/`minor_m` = 2·sqrt(λ), angle from the major eigenvector.
  - `status` becomes `lost` after 5 s with no detections; keep reporting it, frozen.
  - Test: mean error vs `truth_paths` is lower than the raw-detection error, and no clutter is ever used.

- [ ] **3. `analysis/origin.py`** `run(raw, tracks_by_t) -> (origins_by_t, heatmap_by_t)`
  - For each track with ≥3 points: take the earliest up to 5 points, fit a velocity, and project backward from the first point by
    `d = speed × 10 s`. That's the `peak`. `radius_m` = 150 + 0.25·d + the mean ellipse major axis.
  - `confidence` = clip(points_used/5, 0, 1) × clip(1 − radius_m/2000, 0.1, 1).
  - Heat map: sum of 2D Gaussians (sigma = radius_m) on the 100x100 grid, plus a thin Gaussian smear along the back-projection
    line; normalize to max 1.
  - Test: on fake data the peak is within 600 m of the true launch point.

- [ ] **4. `analysis/launch_teams.py`** `run(raw, origins_by_t) -> {t: [LaunchTeam]}`
  - Process origins in time order. If a peak is within 800 m of a team's latest origin, it joins that team. If it's within 2 km
    and more than 25 s after the team's last launch, it joins and counts as a **move** (append to `origin_history`).
    Otherwise it starts a new team.
  - Test: the fake moving team becomes one team with 2 history points.

- [ ] **5. `analysis/forecast.py`** `run(raw, launch_teams_by_t) -> {t: Grid}`
  - For each team: center = last origin + the mean step between history points (zero if only one point). Sigma = 400 m +
    15 m per second since the last launch, capped at 2000 m. Sum the Gaussians and normalize. All zeros if there are no teams.
  - Test: after a move, the forecast peak shifts in the direction of the move.

- [ ] **6. `analysis/sensor_suggest.py`** `run(raw, origin_heatmap_final) -> SensorSuggestion`
  - Mask = heat-map cells not covered by any active allied sensor. Try candidates every 500 m and score each by the masked heat
    mass within 2000 m. Pick the best. `uncertainty_reduction` = best score / total masked mass.
    `reason` = one sentence naming the nearest sensor and the track ids that originate there.

- [ ] **7. `analysis/alerts.py`** `run(frames) -> {t: [Alert]}`. Emit each event once:
  - `new_track` (first frame a track exists) → "Monitor {id}; origin estimate pending."
  - `track_lost` → "Last seen heading {compass direction}; watch for re-detection."
  - `origin_confident` (confidence first ≥ 0.7) → "Launch area located; consider a survey."
  - `launch_team_moved` → "Team relocated; expect launches near the forecast zone."
  - `route_exposed` (risk_level is high) → "Use the safer corridor for {id}."
  - `recon_auto_return` (Frame.recon status is `returned` and risk was above 0.6) → "Survey aborted for safety; replan."
  - Messages name the ids and sensors involved.

- [ ] **8. Integration.** Pull `main`, run `api/pipeline.py` on `demo`, and fix anything that breaks in your modules.
  Then run the whole demo and report bugs to their owners.
