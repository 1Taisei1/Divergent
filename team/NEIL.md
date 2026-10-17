# NEIL — task list
Folders: all of `web/`, `fixtures/`. Branch: `neil/*`. Start task 1 now.
Build against the fixture until Diego sends the Freestyle URL (~1:30), then set `VITE_API_URL` and switch `loadScenario`.

- [x] **1. Scaffold.** `npm create vite@latest web -- --template react-ts`; `npm i leaflet react-leaflet`; dark theme, large base
  font. Layout: map on the left (~70%), a right sidebar with tabs (Layers, Alerts, Explain, Survey, Metrics), and a bottom
  timeline bar.

- [x] **2. `web/src/types.ts`** mirroring every type in CONTRACT.md exactly (Sensor … Scenario, Metrics, ReconRoute, ReconState).

- [x] **3. `fixtures/scenario_demo.json`** — a valid `Scenario` with 20 frames: 4 allied + 2 enemy sensors, 2 tracks forming,
  ~15% clutter detections, small origin/forecast/exposure grids (only a few non-zero cells), 2 routes (one `high` with
  `safer_waypoints`), 1 launch team with 2 history points, a sensor suggestion, a proposed recon route, metrics, and 3 alerts.
  Also `web/src/data.ts` with `loadScenario(id)`.

- [x] **4. Base map.** react-leaflet `MapContainer` with `L.CRS.Simple`, bounds [[0,0],[10000,10000]], a faint 1 km grid. Allied
  sensors are blue, enemy sensors red, both with range circles. Detections accumulate up to the current t; clutter is grey and
  faded, real detections are bright. "Simulated data" badge in a corner.

- [x] **5. Timeline.** Slider 0..duration, play/pause at 4x, and a t readout. All layers render from the frame at t; detections are
  the union of frames ≤ t.

- [x] **6. Tracks + origins.** Track polylines with a head marker and an uncertainty ellipse (rotated). Origin heat map as a canvas
  image overlay, with a translucent orange→red color ramp. Label each OriginEstimate peak "T2 · 72%".

- [x] **7. Sensor contribution view.** Clicking a track highlights its `sensor_ids`, draws thin lines from those sensors to the
  track's detections, and dims everything else. Clicking empty map clears it.

- [x] **8. Planning layers.** Exposure grid as a red coverage overlay. Routes colored by `risk_level` (green/amber/red), with
  `safer_waypoints` dashed green. Forecast heat map in purple. Launch-team `origin_history` as an arrowed path. Sensor suggestion
  as a pulsing "+" with its reason in a tooltip. Every layer gets a toggle.

- [x] **9. Scenario picker** (from `GET /scenarios`) and a **Metrics tab**: big numbers for origin error now vs t=30 (a small line
  chart of `origin_error_m_by_t`), track RMSE and clutter filtered %, plus the label.

- [x] **10. Survey tab.** "Propose survey" → `POST /scenario/{id}/recon/propose?t=` → draw the route and geofence rectangle; show
  risk and info gain. An operator name input plus an **Approve** button (disabled while the name is empty) →
  `POST /recon/approve` → replace the scenario and auto-play from t, showing the recon drone as a white diamond. An **Abort**
  button → `POST /recon/abort`. Show status and the log list.

- [x] **11. Alerts + Explain tabs.** Alerts: newest first, each showing the message plus its recommended action in bold; clicking an
  alert jumps the slider to its t. Explain: a button that calls `POST /explain?t=` and shows the text.

- [x] **12. What-if.** Right-click a sensor → "Disable" or "Move here…" → `POST /whatif` → show the result in a second map
  side-by-side, with linked slider t.

- [x] **12b. Recon pinpoint (added by Diego, do this next).** Pull `main`. Once the approved recon drone sees a launch site, every
  frame carries `confirmed_sites: [{team_id, x, y, radius_m, first_seen_t, last_seen_t, source}]` (CONTRACT.md "ConfirmedSite"; `[]`
  when none). Render it: a bold pin with a ring of `radius_m`, and dim or hide the origin heat map near it so the heat visibly
  collapses to a point. Show the new alert kind `launch_site_confirmed` in the Alerts tab. Also: launch-team entries may now carry
  `confirmed: true`. To test live: `POST /scenario/demo/recon/propose?t=20`, then approve with an operator name at t=20; the pin
  appears around t=81 for LT2. Demo with that run. Fixture update is optional.

- [ ] **13. 3:30 freeze.** `npm run build`, then screen-record the demo flow (about 90 s). At 3:50, make the 30-second launch video in
  Latted from the recording.
