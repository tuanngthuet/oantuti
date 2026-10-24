"""
Cấu hình ứng dụng từ environment variables / .env file.
Fail-fast: nếu secrets còn là giá trị mẫu ở production thì raise lỗi ngay khi khởi động.
"""

import os
from pydantic_settings import BaseSettings
from functools import lru_cache

_INSECURE_DEFAULTS = {
    "change-me-in-production",
    "your-secret-here",
    "secret",
    "",
}


class Settings(BaseSettings):
    # App
    app_name: str = "OTTv2 Arena API"
    app_version: str = "2.0.0"
    debug: bool = False
    max_moves_per_match: int = 200

    # CORS (cho frontend Vercel)
    cors_origins: list[str] = ["*"]

    # Upstash Redis
    upstash_redis_rest_url: str = ""
    upstash_redis_rest_token: str = ""
    # Optional namespace for an isolated local/E2E stack on shared Redis.
    redis_key_prefix: str = ""

    # Worker auth — worker gửi header X-Worker-Secret khi poll/heartbeat
    worker_secret: str = "change-me-in-production"

    # Internal backend secret — Next.js server gửi khi enqueue task (không phải worker)
    internal_backend_secret: str = "change-me-in-production"

    # TTL (giây)
    job_ttl_seconds: int = 3600
    match_ttl_seconds: int = 86400

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

    def validate_secrets(self) -> None:
        """
        Gọi khi khởi động. Raise RuntimeError nếu secrets còn là giá trị mẫu.
        Chỉ enforce khi không phải debug mode (cho phép dev local chạy với defaults).
        """
        if self.debug:
            return

        errors = []
        if self.worker_secret in _INSECURE_DEFAULTS:
            errors.append("WORKER_SECRET is not set or still uses the insecure default value.")
        if self.internal_backend_secret in _INSECURE_DEFAULTS:
            errors.append("INTERNAL_BACKEND_SECRET is not set or still uses the insecure default value.")
        if not self.upstash_redis_rest_url:
            errors.append("UPSTASH_REDIS_REST_URL is required.")
        if not self.upstash_redis_rest_token or self.upstash_redis_rest_token in _INSECURE_DEFAULTS:
            errors.append("UPSTASH_REDIS_REST_TOKEN is required.")

        if errors:
            raise RuntimeError(
                "Server misconfigured — refusing to start:\n" +
                "\n".join(f"  • {e}" for e in errors)
            )


@lru_cache()
def get_settings() -> Settings:
    s = Settings()
    s.validate_secrets()
    return s
