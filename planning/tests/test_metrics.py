import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fake import fake_raw, _drone_path, DURATION_S  # noqa: E402
from metrics import run  # noqa: E402


def _build_frames(raw):
    """Small synthetic pipeline output: tracks with truth ids, origin estimates,
    clutter detections that never make it into tracks."""
    frames = []
    for t in (30, 60, 90, 120):
        tracks = []
        origins = []
        detections = []
        for drone_id, path in raw["truth_paths"].items():
            pts = [p for p in path if p["t"] <= t]
            if len(pts) < 3:
                continue
            truth_launch = next(l for l in raw["truth_launches"] if l["drone_id"] == drone_id)
            # track points = truth + small noise (5 m) -> RMSE ~ 5
            noisy = [{"t": p["t"], "x": p["x"] + 5.0, "y": p["y"]} for p in pts]
            tracks.append({
                "id": f"T-{drone_id}",
                "status": "active",
                "sensor_ids": ["S1", "S2"],
                "points": noisy,
                "current": noisy[-1],
                "truth_drone_id": drone_id,
            })
            # origin peak = true launch + 100 m error
            origins.append({
                "track_id": f"T-{drone_id}",
                "peak": {"x": truth_launch["x"] + 100, "y": truth_launch["y"]},
                "confidence": 0.7,
                "radius_m": 400,
            })
        frames.append({
            "t": t,
            "detections": detections,
            "tracks": tracks,
            "origins": origins,
            "launch_teams": [],
            "origin_heatmap": {},
            "forecast_heatmap": {},
            "exposure_grid": {},
            "routes": [],
            "recon": None,
            "alerts": [],
        })
    return frames


def test_metrics_shape():
    raw = fake_raw()
    frames = _build_frames(raw)
    m = run(raw, frames)
    assert set(m.keys()) == {"origin_error_m_by_t", "track_rmse_m", "clutter_filtered_pct", "label"}
    assert m["label"] == "Measured on simulated data"
    for k in ("30", "60", "90", "120"):
        assert k in m["origin_error_m_by_t"]
        assert m["origin_error_m_by_t"][k] == 100.0  # peak is 100 m from truth


def test_track_rmse_small():
    raw = fake_raw()
    frames = _build_frames(raw)
    m = run(raw, frames)
    assert m["track_rmse_m"] is not None
    assert 4.0 <= m["track_rmse_m"] <= 6.0


def test_clutter_fully_filtered():
    raw = fake_raw()
    frames = _build_frames(raw)
    # add clutter detections at each frame that sit far from any track point
    for f in frames:
        f["detections"] = [
            {"id": "D-C1", "t": f["t"], "sensor_id": "S1", "x": 9000 + f["t"], "y": 9000,
             "sigma_m": 60, "clutter": True, "truth_drone_id": None},
            {"id": "D-C2", "t": f["t"], "sensor_id": "S2", "x": 1000, "y": 1000 + f["t"],
             "sigma_m": 90, "clutter": True, "truth_drone_id": None},
        ]
    m = run(raw, frames)
    assert m["clutter_filtered_pct"] == 100


def test_empty_inputs_do_not_crash():
    raw = fake_raw()
    m = run(raw, [])
    assert m["clutter_filtered_pct"] == 100
    assert m["track_rmse_m"] is None
    assert m["origin_error_m_by_t"] == {}
