"""Link origin estimates into launch teams that may move between launches.

run(raw, origins_by_t) -> {t: [LaunchTeam]}  (see CONTRACT.md)

Each track is assigned once, when its origin first appears (that time stands in for its launch):
- within JOIN_M of a team's latest origin -> joins that team (same site);
- within MOVE_M and more than MOVE_AFTER_S after the team's last launch -> joins and counts as a move;
- otherwise -> a new team.
History points keep following their founding track's latest origin estimate as it refines.
"""

import math

JOIN_M = 800.0
MOVE_M = 2000.0
MOVE_AFTER_S = 25


def _dist(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def _assign(teams, track_id, peak, t):
    """Join the nearest team that accepts this origin, or start a new one."""
    best = None
    for team in teams:
        latest = team["history"][-1]
        d = _dist(peak, latest["peak"])
        if d <= JOIN_M:
            kind = "join"
        elif d <= MOVE_M and t - team["last_launch_t"] > MOVE_AFTER_S:
            kind = "move"
        else:
            continue
        if best is None or d < best[0]:
            best = (d, team, kind)

    if best is None:
        teams.append({"id": f"LT{len(teams) + 1}", "history": [{"t": t, "track_id": track_id, "peak": peak}],
                      "track_ids": [track_id], "last_launch_t": t})
        return
    _, team, kind = best
    team["track_ids"].append(track_id)
    team["last_launch_t"] = t
    if kind == "move":
        team["history"].append({"t": t, "track_id": track_id, "peak": peak})


def run(raw, origins_by_t):
    teams = []
    assigned = set()
    teams_by_t = {}

    for t in range(raw["duration_s"]):
        latest = {o["track_id"]: o["peak"] for o in origins_by_t.get(t, [])}
        for track_id in sorted(latest):
            if track_id not in assigned:
                _assign(teams, track_id, latest[track_id], t)
                assigned.add(track_id)
        for team in teams:
            for h in team["history"]:
                h["peak"] = latest.get(h["track_id"], h["peak"])

        teams_by_t[t] = [
            {"id": team["id"],
             "origin_history": [{"t": h["t"], "x": h["peak"]["x"], "y": h["peak"]["y"]} for h in team["history"]],
             "track_ids": list(team["track_ids"])}
            for team in teams
        ]

    return teams_by_t
