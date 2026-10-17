import json
import logging
import os
import urllib.request
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from api.pipeline import build_scenario
from sim.generate import PRESETS

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="c0mpiled-14 API (simulated data)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

CACHE = {}


@app.on_event("startup")
def _warm():
    ov = json.loads(os.environ.get("SCENARIO_OVERRIDES") or "null")  # set on a what-if clone VM
    for sid in PRESETS:
        CACHE[sid] = build_scenario(sid, overrides=ov)


def _get(sid):
    if sid not in CACHE:
        raise HTTPException(404, f"unknown scenario {sid}")
    return CACHE[sid]


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/scenarios")
def scenarios():
    return [{"id": k, "name": v["name"]} for k, v in PRESETS.items()]


@app.get("/scenario/{sid}")
def scenario(sid: str):
    return _get(sid)


class WhatIf(BaseModel):
    sensor_id: str
    action: Literal["disable", "move"]
    x: float | None = None
    y: float | None = None


@app.post("/scenario/{sid}/whatif")
def whatif(sid: str, body: WhatIf):
    _get(sid)
    if body.action == "disable":
        ov = {"disable": [body.sensor_id]}
    elif body.x is None or body.y is None:
        raise HTTPException(400, "move needs x and y")
    else:
        ov = {"move": {body.sensor_id: [body.x, body.y]}}
    return build_scenario(sid, overrides=ov)  # not cached


def _summary(frame):
    return {
        "t": frame["t"],
        "origins": [{"track": o["track_id"], "x": o["peak"]["x"], "y": o["peak"]["y"], "confidence": o["confidence"]}
                    for o in frame["origins"]],
        "launch_teams": [{"id": lt["id"], "moves": lt["origin_history"][-2:]} for lt in frame["launch_teams"]],
        "routes": [{"id": r["id"], "risk": r["risk"], "level": r["risk_level"]} for r in frame["routes"]],
        "alerts": [a["message"] for a in frame["alerts"][-5:]],
        "active_tracks": len(frame["tracks"]),
    }


def _template(s):
    if not (s["origins"] or s["routes"] or s["alerts"]):
        return f"t={s['t']}s: {s['active_tracks']} active tracks. No origin estimates yet (simulated data)."
    top = max(s["origins"], key=lambda o: o["confidence"], default=None)
    l1 = (f"Best origin estimate: near ({top['x']:.0f}, {top['y']:.0f}) m, confidence {top['confidence']:.0%}."
          if top else "No confident origin estimate yet.")
    risky = [r["id"] for r in s["routes"] if r["level"] == "high"]
    l2 = f"High-risk friendly routes: {', '.join(risky)}." if risky else "No friendly route is at high risk."
    return f"{l1}\n{l2}\nRecommendation only; an operator decides."


def _llm(summary):
    key = os.environ.get("LLM_API_KEY")
    if not key:
        return None
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": os.environ.get("LLM_MODEL", "claude-sonnet-5-5"), "max_tokens": 300,
            "messages": [{"role": "user", "content":
                "Summarize in 3 short plain-English lines for an operator. Include confidence. "
                "Recommend, never decide. All data is simulated.\n" + json.dumps(summary)}],
        }).encode(),
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)["content"][0]["text"]
    except Exception as e:
        logging.warning("explain LLM failed: %r", e)
        return None


@app.post("/scenario/{sid}/explain")
def explain(sid: str, t: int = 0):
    frames = _get(sid)["frames"]
    if not 0 <= t < len(frames):
        raise HTTPException(400, "t out of range")
    s = _summary(frames[t])
    return {"text": _llm(s) or _template(s)}
