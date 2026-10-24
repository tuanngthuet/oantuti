FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv bubblewrap libseccomp2 ca-certificates && rm -rf /var/lib/apt/lists/* && python3 -m venv /opt/ck && useradd --uid 10001 --create-home ck
COPY worker_ck/requirements.txt /tmp/requirements.txt
RUN /opt/ck/bin/pip install --no-cache-dir -r /tmp/requirements.txt
WORKDIR /app
COPY worker_ck/__init__.py /app/worker_ck/__init__.py
COPY worker_ck/common /app/worker_ck/common
COPY worker_ck/third_place /app/worker_ck/third_place
USER 10001:10001
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["/opt/ck/bin/python", "-B", "-m", "worker_ck.third_place"]
