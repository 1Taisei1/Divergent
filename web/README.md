# web/ — operator map (Neil)

React + Vite + TypeScript + react-leaflet (`L.CRS.Simple`, 1 unit = 1 m, 10000 x 10000). All data is simulated.

```bash
cd web && npm install && npm run dev      # http://localhost:5173
npm run build
```

- No `VITE_API_URL` → loads `fixtures/scenario_demo.json`; Explain / What-if / Survey use local previews (`src/offline.ts`).
- `VITE_API_URL=https://<freestyle-url> npm run dev` → everything goes to Diego's API (`src/data.ts`).
- Regenerate the fixture: `node fixtures/make_scenario_demo.mjs` (seeded, deterministic).

Map: click a track → its sensors and detections light up; click empty map to clear. Right-click an allied sensor →
Disable / Move here… (what-if, shown side-by-side). Space = play/pause.
