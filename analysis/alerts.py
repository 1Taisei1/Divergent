"""Turn assembled frames into the actions feed: one alert per event, each with a recommended next step.

run(frames) -> {t: [Alert]}  (see CONTRACT.md)

Runs last, on frames that already hold tracks, origins, launch teams, routes and recon state. Every key
except `t` may be missing or null. Every frame's `t` gets an entry (an empty list when nothing happened).
Within a frame, alerts are ordered by kind (the order of the functions below), then by input order.
Surveillance and decision support only: a human decides what to do with each recommendation.
"""

import math

CONFIDENT_AT = 0.7  # origin confidence that counts as "located"
RECON_RISK_LIMIT = 0.6  # recon returns home above this risk (planning/recon.py)
COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"]


def _alert(t, kind, message, action, ref_id):
    return {"t": t, "kind": kind, "message": message, "recommended_action": action, "ref_id": ref_id}


def _join(names):
    names = list(names)
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def _heading(current):
    """8-point compass word for a velocity; y is north, x is east. 'unknown' when it is not moving."""
    vx, vy = (current or {}).get("vx") or 0.0, (current or {}).get("vy") or 0.0
    if math.hypot(vx, vy) < 0.1:
        return "unknown"
    bearing = math.degrees(math.atan2(vx, vy)) % 360.0  # clockwise from north
    return COMPASS[int((bearing + 22.5) // 45) % 8]


def _near10(v):
    return int(round(v / 10.0)) * 10


def _new_and_lost_tracks(t, tracks, seen, lost):
    new_alerts, lost_alerts = [], []
    for tr in tracks:
        tid = tr["id"]
        sensors = _join(tr.get("sensor_ids") or [])
        if tid not in seen:
            seen.add(tid)
            by = f" by {sensors}" if sensors else ""
            new_alerts.append(_alert(t, "new_track", f"New track {tid} detected{by}.",
                                     f"Monitor {tid}; origin estimate pending.", tid))
        if tr.get("status") == "lost":
            if tid not in lost:
                lost.add(tid)
                had = f"; it was last held by {sensors}" if sensors else ""
                lost_alerts.append(_alert(t, "track_lost", f"Track {tid} lost{had}.",
                                          f"Last seen heading {_heading(tr.get('current'))}; watch for re-detection.", tid))
        else:
            lost.discard(tid)  # back in contact: losing it again is a new event
    return new_alerts, lost_alerts


def _confident_origins(t, origins, located):
    out = []
    for o in origins:
        tid = o["track_id"]
        if tid in located or o.get("confidence", 0.0) < CONFIDENT_AT:
            continue
        located.add(tid)
        peak = o.get("peak") or {}
        out.append(_alert(
            t, "origin_confident",
            f"Launch origin for {tid} located near ({_near10(peak.get('x', 0.0))}, {_near10(peak.get('y', 0.0))}) m"
            f" with {o['confidence']:.0%} confidence.",
            "Launch area located; consider a survey.", tid))
    return out


def _moved_teams(t, teams, history_len):
    out = []
    for lt in teams:
        hist = lt.get("origin_history") or []
        n = len(hist)
        if n > history_len.get(lt["id"], 0) and n >= 2:
            km = math.hypot(hist[-1]["x"] - hist[-2]["x"], hist[-1]["y"] - hist[-2]["y"]) / 1000.0
            tracks = _join(lt.get("track_ids") or [])
            with_tracks = f" (tracks {tracks})" if tracks else ""
            out.append(_alert(t, "launch_team_moved", f"Launch team {lt['id']} relocated {km:.1f} km{with_tracks}.",
                              "Team relocated; expect launches near the forecast zone.", lt["id"]))
        history_len[lt["id"]] = max(n, history_len.get(lt["id"], 0))
    return out


def _exposed_routes(t, routes, exposed):
    out = []
    for r in routes:
        if r.get("risk_level") != "high" or r["id"] in exposed:
            continue
        exposed.add(r["id"])
        by = f" from {_join(r.get('exposed_by') or [])}" if r.get("exposed_by") else ""
        out.append(_alert(t, "route_exposed", f"Route {r['id']} is exposed: risk {r.get('risk', 0.0):.0%}{by}.",
                          f"Use the safer corridor for {r['id']}.", r["id"]))
    return out


def _recon_return(t, recon, max_risk, decided):
    if not recon:
        return []
    rid = recon["route_id"]
    max_risk[rid] = max(max_risk.get(rid, 0.0), recon.get("risk_now") or 0.0)
    if recon.get("status") != "returned" or rid in decided:
        return []
    decided.add(rid)  # decide once, at the first 'returned' frame
    if max_risk[rid] <= RECON_RISK_LIMIT:
        return []
    return [_alert(t, "recon_auto_return",
                   f"Recon {rid} returned early: risk peaked at {max_risk[rid]:.0%}.",
                   "Survey aborted for safety; replan.", rid)]


def run(frames):
    alerts_by_t = {}
    seen_tracks, lost_tracks, located = set(), set(), set()
    history_len, exposed = {}, set()
    recon_max_risk, recon_done = {}, set()

    for frame in sorted(frames, key=lambda f: f["t"]):
        t = frame["t"]
        new_alerts, lost_alerts = _new_and_lost_tracks(t, frame.get("tracks") or [], seen_tracks, lost_tracks)
        alerts_by_t.setdefault(t, []).extend(
            new_alerts
            + lost_alerts
            + _confident_origins(t, frame.get("origins") or [], located)
            + _moved_teams(t, frame.get("launch_teams") or [], history_len)
            + _exposed_routes(t, frame.get("routes") or [], exposed)
            + _recon_return(t, frame.get("recon"), recon_max_risk, recon_done)
        )
    return alerts_by_t
