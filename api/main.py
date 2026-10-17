import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from api.pipeline import build_scenario
from sim.generate import PRESETS

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="c0mpiled-14 API (simulated data)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

CACHE = {}


@app.on_event("startup")
def _warm():
    for sid in PRESETS:
        CACHE[sid] = build_scenario(sid)


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
