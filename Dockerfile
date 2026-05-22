# Multi-stage Dockerfile for OpenSkill
#
# Stage 1: build the frontend with Vite -> dist/
# Stage 2: install production server deps
# Stage 3: minimal runtime image that serves both API and built frontend,
#          with Python 3 + a curated library set so skills can run Python
#          either via `scripts/run.py` or LLM-written agent code.
#
# Persistent data (SQLite + uploaded skill ZIPs + chat artifacts) lives
# outside the image at /app/data, which MUST be mounted as a host bind
# mount so it survives image rebuilds. See docker-compose.deploy.yml.

# ---- Stage 1: build frontend ----
FROM node:20-alpine AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: install server deps ----
FROM node:20-bookworm-slim AS server-deps
WORKDIR /build
# Tools required to compile better-sqlite3 / bcrypt native bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 3: final runtime ----
#
# We switched off `node:20-alpine` here because we need Python 3 + a curated
# scientific stack (pandas, openpyxl, pdfplumber, ...). Wheels for those are
# distributed for glibc; building them on musl/Alpine is painful and adds
# minutes per build.
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/openskill.db \
    STORAGE_DIR=/app/data/storage \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

# Python runtime + a couple of LibreOffice components for spreadsheet
# formula recalc / format conversion on demand. `--no-install-recommends`
# keeps the image close to ~1.2 GB (vs ~600 MB for the previous Alpine
# build). See docs/TODO-python-agent-mode.md for the trade-off rationale.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip \
      libreoffice-core libreoffice-calc libreoffice-writer \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pre-install the Python libraries every skill can rely on. They land in
# /usr/local/lib/python3.*/dist-packages and are exposed via PYTHONPATH
# whenever the runner spawns python3 for a skill.
COPY server/requirements.txt /tmp/req.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /tmp/req.txt \
    && rm -f /tmp/req.txt

# Server source + production deps
COPY --from=server-deps /build/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY server/sql ./server/sql
COPY server/requirements.txt ./server/requirements.txt

# Built frontend served by Fastify @fastify/static
COPY --from=frontend-build /build/dist ./frontend/dist

# Persistent data volume mount point
RUN mkdir -p /app/data/storage/skills

EXPOSE 3000
WORKDIR /app/server
CMD ["node", "src/index.js"]
