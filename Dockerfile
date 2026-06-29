# Multi-stage build from repo root — used by GitHub Actions
FROM node:20-slim AS frontend-builder
WORKDIR /build
COPY web/package*.json ./
RUN npm ci
COPY web/ .
RUN npm run build


FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/app/ ./app/
COPY --from=frontend-builder /build/dist ./static/

VOLUME /data

ENV XKC_DATA_DIR=/data \
    XKC_PORT=3001 \
    PYTHONUNBUFFERED=1

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:3001/api/health || exit 1

CMD ["python", "-m", "uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "3001", \
     "--workers", "1", "--loop", "asyncio"]
