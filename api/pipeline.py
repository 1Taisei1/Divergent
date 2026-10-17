"""Glue: sim -> analysis -> planning -> Scenario. A missing or broken module falls back to empty values."""
import copy
import importlib
import logging

from api.recon_fusion import fuse
from sim.generate import generate

log = logging.getLogger("pipeline")
_MODS = {}


def _load(name):
    if name not in _MODS:
        try:
            _MODS[name] = importlib.import_module(name)
            log.info("loaded %s", name)
        except Exception as e:  # missing or broken module must never break the API
            log.warning("module %s unavailable: %s", name, e)
            _MODS[name] = None
    return _MODS[name]


def _call(mod, fn, default, *args):
    m = _load(mod)
    try:
        return getattr(m, fn)(*args) if m else default
    except Exception as e:
        log.warning("%s.%s failed: %r", mod, fn, e)
        return default


def empty_grid(cell=100, n=100):
    return {"cell_m": cell, "width": n, "height": n, "values": [[0.0] * n for _ in range(n)]}


def build_scenario(scenario_id, overrides=None, recon=None):
    """recon (optional): {"route": ReconRoute, "states": {t: ReconState}, "detections": {t: [Detection]}}"""
    raw = generate(scenario_id, overrides=overrides)
    if recon:
        raw["detections_by_t"] = copy.deepcopy(raw["detections_by_t"])
        for t, ds in recon.get("detections", {}).items():
            raw["detections_by_t"].setdefault(t, []).extend(ds)
    T = raw["duration_s"]
    ts = range(T + 1)

    tracks = _call("analysis.tracker", "run", {}, raw)
    origins, origin_grids = _call("analysis.origin", "run", ({}, {}), raw, tracks)
    teams = _call("analysis.launch_teams", "run", {}, raw, origins)
    confirmed, fusion_alerts = {}, {}
    if recon and recon.get("states"):  # recon sightings turn heat maps into pinpoints
        seen = _call("planning.recon", "sightings", [], raw, recon["states"])
        origins, origin_grids, teams, confirmed, fusion_alerts = fuse(
            T, seen, origins, origin_grids, teams, (recon.get("route") or {}).get("id", "R1"))
    forecast = _call("analysis.forecast", "run", {}, raw, teams)
    exposure_grid, routes = _call("planning.exposure", "run", (empty_grid(), []), raw)
    last_grid = origin_grids.get(T) or origin_grids.get(max(origin_grids, default=0)) or empty_grid()
    suggestion = _call("analysis.sensor_suggest", "run", None, raw, last_grid)

    frames = [{
        "t": t,
        "detections": raw["detections_by_t"].get(t, []),
        "tracks": tracks.get(t, []),
        "origins": origins.get(t, []),
        "launch_teams": teams.get(t, []),
        "origin_heatmap": origin_grids.get(t) or empty_grid(),
        "forecast_heatmap": forecast.get(t) or empty_grid(),
        "exposure_grid": exposure_grid,
        "routes": routes,
        "recon": (recon or {}).get("states", {}).get(t),
        "confirmed_sites": confirmed.get(t, []),
        "alerts": list(fusion_alerts.get(t, [])),
    } for t in ts]

    alerts = _call("analysis.alerts", "run", {}, frames)
    for f in frames:
        f["alerts"] = f["alerts"] + alerts.get(f["t"], [])
    metrics = _call("planning.metrics", "run", None, raw, frames)

    return {
        "id": raw["id"], "name": raw["name"], "seed": raw["seed"], "map": raw["map"],
        "duration_s": T, "sensors": raw["sensors"], "sensor_suggestion": suggestion,
        "recon_route": (recon or {}).get("route"), "metrics": metrics, "frames": frames,
    }
