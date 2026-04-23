"""
main.py
FastAPI application entry point.

Startup sequence
----------------
1. Build the road graph (NetworkX DiGraph)
2. Train (or load cached) the ML model
3. Start background re-routing loop
4. Mount all routers

Shutdown
--------
Gracefully cancel the background re-routing task.
"""

import logging
import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from engine.graph_builder import get_graph
from engine.ml_model import train_model
from engine.rerouting import start_rerouting_loop, stop_rerouting_loop
from routes.optimize import router as optimize_router

# ──────────────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────────────
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s | %(levelname)-8s | %(name)s:%(lineno)d | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("main")


# ──────────────────────────────────────────────────────────────────────────────
# App lifespan (startup / shutdown)
# ──────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── STARTUP ───────────────────────────────────────────────────────────────
    logger.info("=" * 60)
    logger.info("  Dynamic AI Routing Engine  –  Starting up")
    logger.info("=" * 60)

    logger.info("[1/3] Building city road graph …")
    G = get_graph()
    logger.info(
        "      Graph ready: %d nodes, %d edges",
        G.number_of_nodes(), G.number_of_edges(),
    )

    logger.info("[2/3] Initialising ML model …")
    train_model()           # Train or load from cache
    logger.info("      ML model ready.")

    logger.info("[3/3] Starting background re-routing loop …")
    await start_rerouting_loop()
    logger.info("      Re-routing loop active (30s interval).")

    logger.info("=" * 60)
    logger.info("  Server ready.  Visit http://127.0.0.1:8000/docs")
    logger.info("=" * 60)

    yield   # ← app is running

    # ── SHUTDOWN ──────────────────────────────────────────────────────────────
    logger.info("Shutting down …")
    await stop_rerouting_loop()
    logger.info("Re-routing loop stopped. Goodbye.")


# ──────────────────────────────────────────────────────────────────────────────
# App factory
# ──────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Dynamic AI Routing Engine",
    description=(
        "Production-grade spatiotemporal route optimisation engine. "
        "Generates 50+ candidate routes, scores them with multi-criteria "
        "weighted AI, predicts delivery cost with RandomForest, and "
        "continuously re-routes via WebSockets."
    ),
    version="1.0.0",
    contact={
        "name": "Routing Engine API",
        "url":  "http://127.0.0.1:8000/docs",
    },
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

# ──────────────────────────────────────────────────────────────────────────────
# CORS (allow all origins in dev; restrict in prod)
# ──────────────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────────────────────────────────────
# Include routers
# ──────────────────────────────────────────────────────────────────────────────
app.include_router(optimize_router, tags=["Routing"])

# ──────────────────────────────────────────────────────────────────────────────
# Root / health endpoints
# ──────────────────────────────────────────────────────────────────────────────

@app.get("/", tags=["Health"])
def root():
    return {
        "service":     "Dynamic AI Routing Engine",
        "version":     "1.0.0",
        "status":      "running",
        "docs":        "http://127.0.0.1:8000/docs",
        "endpoints": {
            "optimize":         "POST /optimize-route",
            "nodes":            "GET  /routes/nodes",
            "vehicles":         "GET  /routes/vehicles",
            "traffic":          "GET  /routes/traffic-snapshot",
            "weather":          "GET  /routes/weather-snapshot",
            "model_metrics":    "GET  /routes/model-metrics",
            "session":          "GET  /routes/session/{session_id}",
            "websocket":        "WS   /ws/reroute/{session_id}",
        },
    }


@app.get("/health", tags=["Health"])
def health():
    G = get_graph()
    return {
        "status":      "ok",
        "graph_nodes": G.number_of_nodes(),
        "graph_edges": G.number_of_edges(),
    }


# ──────────────────────────────────────────────────────────────────────────────
# Entrypoint
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=True,
        log_level=LOG_LEVEL.lower(),
    )
