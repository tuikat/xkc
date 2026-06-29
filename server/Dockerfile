FROM python:3.12-slim AS server

# System dependencies for audio processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install spotdl in isolated venv (it pins an old fastapi version)
RUN python -m venv /opt/spotdl-env && \
    /opt/spotdl-env/bin/pip install --no-cache-dir spotdl yt-dlp && \
    ln -sf /opt/spotdl-env/bin/spotdl /usr/local/bin/spotdl && \
    ln -sf /opt/spotdl-env/bin/yt-dlp /usr/local/bin/yt-dlp

# Main Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY app/ ./app/

# Copy pre-built frontend (run 'npm run build' in web/ first, then copy dist/ to server/static/)
COPY static/ ./static/

# Data directory (mount as volume)
VOLUME /data

ENV XKC_DATA_DIR=/data \
    XKC_PORT=3002 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:${XKC_PORT:-3002}/api/health || exit 1

CMD ["sh", "-c", "python -m uvicorn app.main:app --host 0.0.0.0 --port ${XKC_PORT:-3002} --workers 1 --loop asyncio"]
