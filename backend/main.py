from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

try:
    from api import annotations, events, inventory, models, outlines, receipts, scans, system
    from core.config import CORS_ORIGINS, UPLOAD_DIR
    from services import runtime
except ModuleNotFoundError:
    from backend.api import annotations, events, inventory, models, outlines, receipts, scans, system
    from backend.core.config import CORS_ORIGINS, UPLOAD_DIR
    from backend.services import runtime


@asynccontextmanager
async def lifespan(_: FastAPI):
    runtime.ensure_schema()
    runtime.get_detection_model()
    yield


app = FastAPI(title="Fridge 9000 API", lifespan=lifespan)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in (
    system.router,
    models.router,
    inventory.router,
    annotations.router,
    scans.router,
    outlines.router,
    events.router,
    receipts.router,
):
    app.include_router(router)
