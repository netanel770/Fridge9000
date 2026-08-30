from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from api import (
        auth,
        annotations,
        events,
        households,
        inventory,
        models,
        outlines,
        receipts,
        scans,
        system,
        system_admins,
    )
    from core.config import CORS_ORIGINS
    from services import runtime
except ModuleNotFoundError:
    from backend.api import (
        auth,
        annotations,
        events,
        households,
        inventory,
        models,
        outlines,
        receipts,
        scans,
        system,
        system_admins,
    )
    from backend.core.config import CORS_ORIGINS
    from backend.services import runtime


@asynccontextmanager
async def lifespan(_: FastAPI):
    runtime.ensure_schema()
    runtime.get_detection_model()
    yield


app = FastAPI(title="Fridge 9000 API", lifespan=lifespan)

# Native React Native clients are not subject to browser CORS rules, while
# Expo Web is. Keep explicitly configured origins and also allow local/LAN
# development hosts on arbitrary ports so Expo can move ports when needed.
LOCAL_DEVELOPMENT_ORIGIN_REGEX = (
    r"^https?://("
    r"localhost|"
    r"127\.0\.0\.1|"
    r"10\.\d+\.\d+\.\d+|"
    r"192\.168\.\d+\.\d+|"
    r"172\.(1[6-9]|2\d|3[01])\.\d+\.\d+"
    r"):\d+$"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_origin_regex=LOCAL_DEVELOPMENT_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in (
    auth.router,
    households.router,
    system_admins.router,
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
