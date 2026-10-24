# Build from the repository root: docker build -f worker_image/Dockerfile .
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv bubblewrap libseccomp2 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/worker-venv \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin worker

COPY worker_image/requirements.txt /tmp/requirements.txt
RUN /opt/worker-venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
COPY worker_image/worker.py worker_image/supervisor.py worker_image/runtime.py worker_image/game_engine.py /app/worker_image/
COPY worker_image/main.py worker_image/runner.py worker_image/sandbox_launcher.py /app/worker_image/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WORKER_ENV_FILE=/app/worker_image/.env
USER 10001:10001
ENTRYPOINT ["/opt/worker-venv/bin/python", "-B", "/app/worker_image/main.py"]

# Separate test target; production has no backend/test dependencies.
FROM runtime AS test
USER root
COPY backend/requirements.txt /tmp/test-requirements.txt
RUN /opt/worker-venv/bin/pip install --no-cache-dir -r /tmp/test-requirements.txt
COPY backend/app /app/backend/app/
COPY backend/tests /app/backend/tests/
COPY backend/scripts/repair_queue_duplicates.py /app/backend/scripts/repair_queue_duplicates.py
COPY worker_image/tests /app/worker_image/tests/
COPY worker_image/__init__.py /app/worker_image/__init__.py
ENV PYTHONPATH=/app/backend \
    REQUIRE_SANDBOX_TESTS=1
USER 10001:10001
ENTRYPOINT ["/opt/worker-venv/bin/python", "-B", "-m", "pytest", "-p", "no:cacheprovider", "-q"]
CMD ["worker_image/tests", "backend/tests/test_worker.py", "backend/tests/test_supervisor.py", "backend/tests/test_queue.py", "backend/tests/test_worker_control.py"]

# Portable identity support, without credentials: safe for public distribution.
FROM runtime AS portable
USER root
RUN mkdir -p /var/lib/oantuti && chown 10001:10001 /var/lib/oantuti
ENV WORKER_MACHINE_ID_FILE=/var/lib/oantuti/machine-id
USER 10001:10001

# Optional private image. The installed .env intentionally remains in this image.
FROM portable AS bundled
USER root
ARG WORKER_ENV_SHA256
RUN --mount=type=secret,id=worker_env,required=true \
    test -n "$WORKER_ENV_SHA256" \
    && install -o 10001 -g 10001 -m 0400 /run/secrets/worker_env /app/worker_image/.env
USER 10001:10001

FROM runtime AS production
