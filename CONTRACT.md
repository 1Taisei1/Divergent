# CONTRACT.md — Data contract (single source of truth)

All four of us build against these shapes. **Changing this file needs Diego's OK** and a heads-up to everyone.
If it changes, update `fixtures/` in the same commit.

All data is **synthetic**. No real sensor specs, locations, or performance numbers.

---

## Coordinate system
- Flat 2D map, units in **meters**. Map is `10000 x 10000` m. `(0,0)` bottom-left; `x` east, `y` north.
- Grid cells `100 m` → grids are `100 x 100`, `grid[row][col]`, `row = floor(y/100)`, `col = floor(x/100)`.
- Time `t` in **seconds** from scenario start. One frame per `1 s`. Default length `120 s`.
- Frontend maps meters to the screen with a simple CRS (no real terrain).

---

## JSON types

### Sensor
```json
{ "id": "S1", "side": "allied", "type": "radar", "x": 2500, "y": 4000, "range_m": 2000, "active": true }
```
`side`: `"allied" | "enemy"` · `type`: `"radar" | "acoustic" | "rf"` · enemy sensor ids start with `ES`.

### Detection
```json
{ "id": "D-000123", "t": 37, "sensor_id": "S1", "x": 3120.4, "y": 4410.9,
  "sigma_m": 60, "clutter": false, "truth_drone_id": "E2" }
```
`truth_drone_id` is null for clutter. Tracker may use it to associate (hackathon shortcut).
Detections from the recon drone use `sensor_id: "R1"`.

### Track
```json
{ "id": "T2", "status": "active", "sensor_ids": ["S1","S3"],
  "points": [{ "t": 30, "x": 3000, "y": 4300 }],
  "current": { "x": 3110, "y": 4400, "vx": 12.1, "vy": 8.4 },
  "ellipse": { "major_m": 140, "minor_m": 80, "angle_deg": 35 } }
```
`status`: `"active" | "lost"`.

### Grid (all heat maps)
```json
{ "cell_m": 100, "width": 100, "height": 100, "values": [[0.0, 0.01]] }
```
`values` is `float[height][width]`, 0..1, normalized so max = 1 (all zeros allowed).

### OriginEstimate
```json
{ "track_id": "T2", "peak": { "x": 1800, "y": 3600 }, "confidence": 0.72, "radius_m": 450 }
```

### LaunchTeam (moving launch site, linked origins over time)
```json
{ "id": "LT1", "origin_history": [{ "t": 20, "x": 1800, "y": 3600 }, { "t": 75, "x": 2400, "y": 3100 }],
  "track_ids": ["T1","T3"] }
```

### FriendlyRoute
```json
{ "id": "F1", "waypoints": [{ "x": 8000, "y": 1000 }, { "x": 6000, "y": 3000 }],
  "risk": 0.64, "risk_level": "high", "exposed_by": ["ES2"],
  "safer_waypoints": [{ "x": 8000, "y": 1000 }, { "x": 7200, "y": 2600 }, { "x": 6000, "y": 3000 }] }
```
`risk_level`: `"low"` (<0.33) `| "medium" | "high"` (>=0.66). `safer_waypoints` may be null.

### SensorSuggestion ("where to add a sensor")
```json
{ "x": 3500, "y": 5200, "uncertainty_reduction": 0.31, "reason": "Covers the gap west of S2 where T1 and T3 originate." }
```

### LaunchSiteOption ("where can our team launch without being traced")
```json
{ "x": 8450, "y": 950, "concealment": 1.0, "exposure_at_site": 0.0, "distance_to_coverage_m": 3400,
  "nearest_enemy_sensor": "ES2",
  "reason": "3.4 km outside ES2 coverage; the first 1.5 km of flight is unobserved." }
```
The reverse of origin estimation: a launch is hard to trace back when the site is outside enemy coverage, far from
its edge, and the first leg of flight is unobserved. `distance_to_coverage_m` is null when no enemy sensor is active.

### ReconRoute (surveillance only, human approved)
```json
{ "id": "R1", "waypoints": [{ "x": 8000, "y": 1000 }],
  "info_gain": 0.58, "risk": 0.21, "geofence": { "x_min": 4000, "x_max": 9000, "y_min": 500, "y_max": 6000 },
  "status": "proposed", "approved_by": null, "approved_at": null, "log": [] }
```
`status`: `"proposed" | "approved" | "flying" | "aborted" | "returned"`.
`log`: `[{ "t": 60, "event": "approved", "by": "operator" }]`.

### ReconState (per frame, only while a survey is flying)
```json
{ "route_id": "R1", "x": 7100, "y": 2200, "status": "flying", "risk_now": 0.18 }
```

### Metrics (accuracy scoreboard, simulated ground truth)
```json
{ "origin_error_m_by_t": { "30": 410, "60": 210, "90": 95 }, "track_rmse_m": 48,
  "clutter_filtered_pct": 94, "label": "Measured on simulated data" }
```

### Alert (actions feed)
```json
{ "t": 52, "kind": "new_track", "message": "New track T3 detected by S2 and S4.",
  "recommended_action": "Monitor T3; origin estimate pending.", "ref_id": "T3" }
```
`kind`: `"new_track" | "track_lost" | "origin_confident" | "launch_team_moved" | "launch_forecast" | "route_exposed" | "recon_auto_return" | "launch_site_confirmed"`.

### ConfirmedSite (recon pinpoint; added Oct 17, additive)
```json
{ "team_id": "LT1", "x": 1472.0, "y": 3035.1, "radius_m": 60, "first_seen_t": 81, "last_seen_t": 119, "source": "R1" }
```
Present in `Frame.confirmed_sites` once the approved recon drone has seen a launch site (it stays, last known position,
after the drone leaves). The matching `OriginEstimate`s snap to this point (`radius_m` 60, confidence >= 0.97), the matching
`LaunchTeam` gets `"confirmed": true`, and `origin_heatmap` collapses to a spike there. Frontend: draw a pin, fade the heat.

### Frame
```json
{ "t": 52,
  "detections": [], "tracks": [], "origins": [], "launch_teams": [],
  "origin_heatmap": {}, "forecast_heatmap": {}, "exposure_grid": {},
  "routes": [], "recon": null, "confirmed_sites": [], "alerts": [] }
```
`detections` holds ONLY detections with this `t`; frontend accumulates up to slider time.

### Scenario
```json
{ "id": "demo", "name": "Two launch teams, cluttered sensors", "seed": 42,
  "map": { "width_m": 10000, "height_m": 10000, "cell_m": 100 },
  "duration_s": 120, "sensors": [], "sensor_suggestion": null,
  "launch_site_grid": null, "launch_site_options": [],
  "recon_route": null, "metrics": null, "frames": [] }
```
`launch_site_grid` is a Grid of concealment (0..1, 1 = hardest to trace); static per scenario, like `sensor_suggestion`.
Preset ids: `demo`, `single`, `swarm`, `sparse`.

---

## API (Diego owns `api/`)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | | `{ "ok": true }` |
| GET | `/scenarios` | | `[{ "id", "name" }]` |
| GET | `/scenario/{id}` | | `Scenario` |
| POST | `/scenario/{id}/explain?t=52` | | `{ "text": "..." }` |
| POST | `/scenario/{id}/whatif` | `{ "sensor_id": "S3", "action": "disable" \| "move", "x"?: n, "y"?: n }` | `Scenario` (recomputed) |
| POST | `/scenario/{id}/recon/propose?t=40` | | `ReconRoute` (status `proposed`) |
| POST | `/scenario/{id}/recon/approve` | `{ "route_id": "R1", "operator": "Diego", "t": 40 }` | `Scenario` with recon flight in frames from `t` |
| POST | `/scenario/{id}/recon/abort` | `{ "route_id": "R1", "t": 70 }` | `Scenario` with return-to-home from `t` |

CORS open. JSON only. Nothing flies without `approve`.

---

## Python module interfaces (so four people can build in parallel)

Every module is a **pure function on plain dicts** shaped like the JSON above. No module imports another person's
module except through `api/pipeline.py` (Diego). Each owner writes their own tiny fake input for testing.

```python
# sim/generate.py            (Diego)
generate(scenario_id: str, seed: int = 42, overrides: dict | None = None) -> dict
# returns RawScenario:
# { id, name, seed, map, duration_s, sensors: [Sensor],
#   detections_by_t: {t: [Detection]}, friendly_routes: [{id, waypoints}],
#   home_base: {x, y},                        # friendly launch point for recon
#   truth_paths: {drone_id: [{t, x, y}]},     # ground truth, for metrics only
#   truth_launches: [{drone_id, team_id, t, x, y}] }

# analysis/tracker.py        (Leo)
run(raw: dict) -> dict[int, list[Track]]                     # tracks_by_t

# analysis/origin.py         (Leo)
run(raw, tracks_by_t) -> tuple[dict[int, list[OriginEstimate]], dict[int, Grid]]

# analysis/launch_teams.py   (Leo)
run(raw, origins_by_t) -> dict[int, list[LaunchTeam]]

# analysis/alerts.py         (Leo) — runs last, sees assembled frames
run(frames: list[Frame]) -> dict[int, list[Alert]]

# planning/exposure.py       (Ali)
run(raw) -> tuple[Grid, list[FriendlyRoute]]                 # enemy sensors are static

# analysis/forecast.py       (Leo)
run(raw, launch_teams_by_t) -> dict[int, Grid]               # forecast_heatmap per t

# analysis/sensor_suggest.py (Leo)
run(raw, origin_heatmap_final: Grid) -> SensorSuggestion

# planning/launch_sites.py   (Ali) — friendly launch-site concealment, the reverse of origin.py
run(raw, exposure_grid: Grid) -> tuple[Grid, list[LaunchSiteOption]]   # up to 3 options within 4 km of home_base

# planning/metrics.py        (Ali) — accuracy scoreboard vs simulator ground truth
run(raw, frames: list[Frame]) -> Metrics

# planning/recon.py          (Ali)
propose(raw, frame: Frame, exposure_grid: Grid) -> ReconRoute
fly(raw, route: ReconRoute, t_start: int, exposure_grid: Grid, abort_t: int | None = None)
    -> tuple[dict[int, ReconState], dict[int, list[Detection]], list[log]]   # positions, new R1 detections, flight log
sightings(raw, recon_by_t) -> list[{t, team_id, x, y, radius_m}]   # launch sites the recon drone can see
```

### Recon guardrails (must be enforced in `planning/recon.py` (Ali))
- Surveillance only. No payload, engagement, or strike concepts anywhere in the code or UI.
- Never moves unless `approve` was called with an operator name; every state change goes in `log`.
- Stays inside `geofence`.
- Auto return-to-home if `risk_now` > 0.6; raises a `recon_auto_return` alert.
- `abort` → immediate return-to-home.
