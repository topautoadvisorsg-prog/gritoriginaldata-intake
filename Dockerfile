# syntax=docker/dockerfile:1
# GRIT Data Engine — single-service image.
# FastAPI backend serves the API AND the compiled React operator dashboard.

# ---- Stage 1: build the React operator dashboard ----
FROM node:20-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: Python backend runtime ----
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /app

# System libraries required by Pillow (JPEG/PNG/WebP/TIFF/freetype/lcms/openjpeg)
RUN apt-get update && apt-get install -y --no-install-recommends \
      libjpeg62-turbo zlib1g libfreetype6 libwebp7 liblcms2-2 libopenjp2-7 libtiff6 \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install -r backend/requirements.txt

COPY backend/ ./backend/
# Built dashboard goes where main.py expects it: ../../frontend/dist from backend/app
COPY --from=frontend /app/frontend/dist ./frontend/dist

WORKDIR /app/backend
EXPOSE 8000
# Railway injects $PORT; default to 8000 for `docker run` locally.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
