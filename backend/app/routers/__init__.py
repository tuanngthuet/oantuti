from .health import router as health_router
from .workers import router as workers_router
from .friendly import router as friendly_router
from .workers_queue import router as workers_queue_router
from .rating import router as rating_router

__all__ = [
    "health_router",
    "workers_router",
    "friendly_router",
    "workers_queue_router",
    "rating_router",
]
