# AGENTS.md (Codex — Neil)

## On every session start — do this immediately, without asking
1. Open `team/NEIL.md` and `CONTRACT.md`.
2. Start the first unchecked task in `team/NEIL.md`. When it's done and renders, change `- [ ]` to `- [x]`, commit,
   and move to the next. Don't wait for confirmation between tasks unless a task says to.

## Ownership
You own all of `web/` and `fixtures/`. Never edit `sim/`, `api/`, `analysis/`, `planning/`, or `CONTRACT.md`.
If the contract needs to change, write the proposed change in chat and stop.

## Rules
- React + Vite + TypeScript, Leaflet via react-leaflet with `L.CRS.Simple` (1 unit = 1 meter, 10000 x 10000). No real map tiles.
- `web/src/types.ts` mirrors `CONTRACT.md` exactly.
- All data goes through one function `loadScenario(id)` in `web/src/data.ts`: fixture first, then `import.meta.env.VITE_API_URL`.
- Every layer has a toggle. Projector-readable: large fonts, high contrast, dark background.
- A "Simulated data" badge is always visible.
- Commit small and often on `neil/*`; keep `main` runnable. If a task takes more than 30 minutes, propose a simpler version.
- Scope is surveillance and decision support only: no weapons, engagement, targeting, or strike UI.

## Commands
- `cd web && npm install && npm run dev`
- `npm run build`
