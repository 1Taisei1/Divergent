"""Fold recon sightings into the analysis output: heat map -> pinpoint, plus alerts.

Runs between launch_teams and forecast so the forecast also re-centres on a confirmed site.
Sightings come from planning.recon.sightings (only exist after an operator approved a flight).
"""
import math

import numpy as np

GATE_M = 900.0          # an origin estimate this close to a pinpoint is the same site
PIN_CONFIDENCE = 0.97
PIN_SIGMA_M = 120.0


def _latest(obs_by_team, t):
    """team_id -> latest sighting at or before t."""
    out = {}
    for team, obs in obs_by_team.items():
        seen = [o for o in obs if o["t"] <= t]
        if seen:
            out[team] = seen[-1]
    return out


def _pin_grid(grid, pins):
    arr = np.array(grid["values"], dtype=float)
    h, w = arr.shape
    cell = grid["cell_m"]
    xs = (np.arange(w) + 0.5) * cell
    ys = (np.arange(h) + 0.5) * cell
    X, Y = np.meshgrid(xs, ys)
    for p in pins:
        d2 = (X - p["x"]) ** 2 + (Y - p["y"]) ** 2
        near = d2 <= GATE_M ** 2
        arr[near] = np.exp(-d2[near] / (2 * PIN_SIGMA_M ** 2))
    if arr.max() > 0:
        arr /= arr.max()
    return {**grid, "values": np.round(arr, 3).tolist()}


def fuse(T, observations, origins_by_t, grids_by_t, teams_by_t, recon_id="R1"):
    """Returns (origins_by_t, grids_by_t, teams_by_t, confirmed_by_t, alerts_by_t)."""
    obs_by_team = {}
    for o in sorted(observations, key=lambda o: o["t"]):
        obs_by_team.setdefault(o["team_id"], []).append(o)
    first_seen = {}
    for o in sorted(observations, key=lambda o: o["t"]):
        first_seen.setdefault((o["team_id"], o["x"], o["y"]), o["t"])

    confirmed_by_t, alerts_by_t = {}, {}
    origins_by_t, grids_by_t, teams_by_t = dict(origins_by_t), dict(grids_by_t), dict(teams_by_t)
    announced = set()
    for t in range(T + 1):
        latest = _latest(obs_by_team, t)
        if not latest:
            continue
        pins = list(latest.values())

        def near_pin(x, y):
            return next((p for p in pins if math.hypot(x - p["x"], y - p["y"]) <= GATE_M), None)

        origins = []
        for o in origins_by_t.get(t, []):
            p = near_pin(o["peak"]["x"], o["peak"]["y"])
            origins.append({**o, "peak": {"x": p["x"], "y": p["y"]}, "radius_m": p["radius_m"],
                            "confidence": max(o["confidence"], PIN_CONFIDENCE)} if p else o)
        origins_by_t[t] = origins

        if grids_by_t.get(t):
            grids_by_t[t] = _pin_grid(grids_by_t[t], pins)

        label = {}  # truth team id -> the analysis team id it matches
        teams = []
        for lt in teams_by_t.get(t, []):
            hist = lt.get("origin_history") or []
            p = near_pin(hist[-1]["x"], hist[-1]["y"]) if hist else None
            if p:
                label[p["team_id"]] = lt["id"]
                lt = {**lt, "confirmed": True,
                      "origin_history": hist[:-1] + [{"t": hist[-1]["t"], "x": p["x"], "y": p["y"]}]}
            teams.append(lt)
        teams_by_t[t] = teams

        sites = []
        for p in pins:
            tid = label.get(p["team_id"], p["team_id"])
            fs = first_seen[(p["team_id"], p["x"], p["y"])]
            sites.append({"team_id": tid, "x": p["x"], "y": p["y"], "radius_m": p["radius_m"],
                          "first_seen_t": fs, "last_seen_t": p["t"], "source": recon_id})
            if fs == t and (tid, fs) not in announced:
                announced.add((tid, fs))
                alerts_by_t.setdefault(t, []).append({
                    "t": t, "kind": "launch_site_confirmed", "ref_id": tid,
                    "message": f"Recon {recon_id} pinpointed launch site of {tid} at ({p['x']:.0f}, {p['y']:.0f}) ±{p['radius_m']:.0f} m.",
                    "recommended_action": "Origin heat map collapsed to a point and the forecast re-centred. Keep recon outside enemy sensor coverage."})
        confirmed_by_t[t] = sites
    return origins_by_t, grids_by_t, teams_by_t, confirmed_by_t, alerts_by_t
