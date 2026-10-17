"""Run the analysis chain on Diego's simulator (`generate("demo")`) and check it against the sim's ground truth."""

import math

import pytest

from analysis import launch_teams, origin, tracker

generate = pytest.importorskip("sim.generate").generate


@pytest.fixture(scope="module")
def demo():
    raw = generate("demo")
    tracks_by_t = tracker.run(raw)
    origins_by_t, heatmap_by_t = origin.run(raw, tracks_by_t)
    teams_by_t = launch_teams.run(raw, origins_by_t)

    # tracks are numbered in order of first detection
    first = {}
    for t in sorted(raw["detections_by_t"]):
        for d in raw["detections_by_t"][t]:
            if not d["clutter"] and d["truth_drone_id"] not in first:
                first[d["truth_drone_id"]] = t
    drone_of = {f"T{i + 1}": k for i, k in enumerate(sorted(first, key=lambda k: (first[k], k)))}
    return raw, tracks_by_t, origins_by_t, teams_by_t, drone_of


def test_every_frame_including_the_last(demo):
    raw, tracks_by_t, origins_by_t, teams_by_t, _ = demo
    T = raw["duration_s"]
    assert sorted(tracks_by_t) == sorted(origins_by_t) == sorted(teams_by_t) == list(range(T + 1))
    assert len(tracks_by_t[T]) == len(raw["truth_paths"])


def test_origins_near_true_launches(demo):
    raw, _, origins_by_t, _, drone_of = demo
    launches = {l["drone_id"]: l for l in raw["truth_launches"]}
    final = origins_by_t[raw["duration_s"]]
    errs = [math.hypot(o["peak"]["x"] - launches[drone_of[o["track_id"]]]["x"],
                       o["peak"]["y"] - launches[drone_of[o["track_id"]]]["y"]) for o in final]
    assert len(errs) == len(raw["truth_launches"])
    assert sum(errs) / len(errs) < 150
    assert max(errs) < 300


def test_launch_teams_match_truth(demo):
    raw, _, _, teams_by_t, drone_of = demo
    true_team = {l["drone_id"]: l["team_id"] for l in raw["truth_launches"]}
    true_sites = {}
    for l in raw["truth_launches"]:
        true_sites.setdefault(l["team_id"], set()).add((l["x"], l["y"]))

    final = teams_by_t[raw["duration_s"]]
    assert len(final) == len(true_sites)
    for team in final:
        members = {true_team[drone_of[tid]] for tid in team["track_ids"]}
        assert len(members) == 1  # never mixes two real teams
        assert len(team["origin_history"]) == len(true_sites[members.pop()])  # one history point per site, moves included
