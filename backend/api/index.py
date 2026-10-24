"""
Vercel entrypoint cho FastAPI.
Vercel expects a WSGI/ASGI app at api/index.py.
"""
import sys
import os

# Thêm thư mục cha vào path để import được app.*
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.main import app  # noqa: F401 — Vercel imports 'app' from this module
