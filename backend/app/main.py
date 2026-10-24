"""
OTTv2 Arena API - Entry point FastAPI.

Khởi động: uvicorn app.main:app --reload
"""

import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routers.health import router as health_router
from .routers.workers import router as workers_router
from .routers.friendly import router as friendly_router
from .routers.workers_queue import router as workers_queue_router
from .routers.rating import router as rating_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="""
## OTTv2 Arena API

API quản lý trận đấu phân tán với Redis Queue + Worker.

### Hai loại trận
- **rating / validation**: TrueSkill continuous rating, do scheduler tự động tạo.
- **friendly**: Người dùng tạo thủ công, không ảnh hưởng rating.

### Auth
- Worker → Backend: header `X-Worker-Secret`
- Next.js server → Backend: header `X-Internal-Secret`
- Worker → Next.js callback: header `X-Worker-Callback-Secret`
    """,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(workers_router)
app.include_router(friendly_router)
app.include_router(workers_queue_router)
app.include_router(rating_router)
