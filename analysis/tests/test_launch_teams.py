from analysis import launch_teams, origin, tracker
from analysis.tests.fake import fake_raw


def _origin(track_id, x, y):
    return {"track_id": track_id, "peak": {"x": x, "y": y}, "confidence": 0.8, "radius_m": 300}


def test_fake_moving_team_is_one_team_with_two_history_points():
    raw = fake_raw()
    origins_by_t, _ = origin.run(raw, tracker.run(raw))
    final = launch_teams.run(raw, origins_by_t)[raw["duration_s"] - 1]
    assert len(final) == 1
    team = final[0]
    assert team["id"] == "LT1"
    assert team["track_ids"] == ["T1", "T2"]
    assert len(team["origin_history"]) == 2
    assert team["origin_history"][0]["y"] > team["origin_history"][1]["y"]  # the fake team moved south


def test_join_move_and_new_team():
    raw = {"duration_s": 60}
    origins_by_t = {t: [] for t in range(60)}
    timeline = [
        (5, _origin("T1", 2000, 7000)),
        (15, _origin("T2", 2300, 7200)),   # 360 m away -> same site, joins
        (25, _origin("T3", 3200, 7000)),   # 1.2 km but only 10 s after the last launch -> new team
        (45, _origin("T4", 1200, 6200)),   # 1.1 km from LT1 (but 2 km from LT2), 30 s after its last launch -> LT1 moved
        (50, _origin("T5", 7000, 2000)),   # far away -> new team
    ]
    for start, o in timeline:
        for t in range(start, 60):
            origins_by_t[t].append(o)

    teams_by_t = launch_teams.run(raw, origins_by_t)
    final = {team["id"]: team for team in teams_by_t[59]}
    assert final["LT1"]["track_ids"] == ["T1", "T2", "T4"]
    assert [(h["t"], h["x"], h["y"]) for h in final["LT1"]["origin_history"]] == [(5, 2000, 7000), (45, 1200, 6200)]
    assert final["LT2"]["track_ids"] == ["T3"]
    assert final["LT3"]["track_ids"] == ["T5"]
    assert teams_by_t[4] == []
    assert len(teams_by_t[44][0]["origin_history"]) == 1
