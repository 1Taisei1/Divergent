"""Link origin estimates into launch teams that may move between launches.

run(raw, origins_by_t) -> {t: [LaunchTeam]}  (see CONTRACT.md)

Each track is assigned once, when its origin first appears (that time stands in for its launch):
- within JOIN_M of a team's latest origin -> joins that team (same site);
- within MOVE_M and more than MOVE_AFTER_S after the team's last launch -> joins and counts as a move;
- otherwise -> a new team.
History points keep following their founding track's latest origin estimate as it refines.
A track is assigned once its origin has settled: confidence >= SETTLED_CONF (triangulated), or SETTLE_S after it first
appeared. An age-based assignment is provisional: a drone first seen far from its launch site starts with a rough
estimate, so when its origin later becomes confident it is taken out of its team (an emptied team is dropped) and
assigned again on the good estimate.
"""

import math

JOIN_M = 800.0
MOVE_M = 2000.0
MOVE_AFTER_S = 25
SETTLED_CONF = 0.7
SETTLE_S = 10


def _dist(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def _unassign(teams, track_id):
    for team in teams:
        if track_id in team["track_ids"]:
            team["track_ids"].remove(track_id)
            team["history"] = [h for h in team["history"] if h["track_id"] != track_id]
            if team["track_ids"] and not team["history"]:  # founder left: next member's latest origin stands in
                team["history"] = [{"t": team["last_launch_t"], "track_id": team["track_ids"][0], "peak": None}]
    teams[:] = [team for team in teams if team["track_ids"]]


def _assign(teams, track_id, peak, t, next_id):
    """Join the nearest team that accepts this origin, or start a new one."""
    best = None
    for team in teams:
        latest = team["history"][-1]
        if latest["peak"] is None:  # founder was re-placed and its successor has no estimate this frame
            continue
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
        teams.append({"id": f"LT{next_id()}", "history": [{"t": t, "track_id": track_id, "peak": peak}],
                      "track_ids": [track_id], "last_launch_t": t})
        return
    _, team, kind = best
    team["track_ids"].append(track_id)
    team["last_launch_t"] = t
    if kind == "move":
        team["history"].append({"t": t, "track_id": track_id, "peak": peak})


def run(raw, origins_by_t):
    teams = []
    assigned = {}  # track_id -> True if provisional (assigned on age, before its origin was confident)
    teams_by_t = {}
    counter = [0]

    def next_id():
        counter[0] += 1
        return counter[0]

    first_seen = {}
    for t in range(raw["duration_s"] + 1):
        origins = {o["track_id"]: o for o in origins_by_t.get(t, [])}
        latest = {tid: o["peak"] for tid, o in origins.items()}
        for track_id in sorted(latest):
            confident = origins[track_id].get("confidence", 1.0) >= SETTLED_CONF
            if assigned.get(track_id) and confident:  # provisional and now triangulated: place it again
                _unassign(teams, track_id)
                del assigned[track_id]
        for team in teams:  # refresh positions before comparing new origins against them
            for h in team["history"]:
                h["peak"] = latest.get(h["track_id"], h["peak"])
        for track_id in sorted(latest):
            first_seen.setdefault(track_id, t)
            confident = origins[track_id].get("confidence", 1.0) >= SETTLED_CONF
            if track_id not in assigned and (confident or t - first_seen[track_id] >= SETTLE_S):
                _assign(teams, track_id, latest[track_id], t, next_id)
                assigned[track_id] = not confident

        teams_by_t[t] = [
            {"id": team["id"],
             "origin_history": [{"t": h["t"], "x": h["peak"]["x"], "y": h["peak"]["y"]} for h in team["history"]],
             "track_ids": list(team["track_ids"])}
            for team in teams
        ]

    # Number teams that survive to the end LT1, LT2, ... in order of appearance; dropped provisional teams come after.
    order = []
    for t in sorted(teams_by_t):
        for team in teams_by_t[t]:
            if team["id"] not in order:
                order.append(team["id"])
    final = {team["id"] for team in teams_by_t.get(raw["duration_s"], [])}
    ranked = [i for i in order if i in final] + [i for i in order if i not in final]
    rename = {old: f"LT{n + 1}" for n, old in enumerate(ranked)}
    for t in teams_by_t:
        for team in teams_by_t[t]:
            team["id"] = rename[team["id"]]
    return teams_by_t
