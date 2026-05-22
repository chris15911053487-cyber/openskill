# Multi-stage Dockerfile for OpenSkill
#
# Stage 1: build the frontend with Vite -> dist/
# Stage 2: install production server deps
# Stage 3: minimal runtime image that serves both API and built frontend
#
# Persistent data (SQLite + uploaded skill ZIPs) lives outside the image at
# /app/data, which MUST be mounted as a host bind mount so it survives image
# rebuilds. See docker-compose.deploy.yml.

# ---- Stage 1: build frontend ----
FROM node:20-alpine AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- Stage 2: install server deps ----
FROM node:20-alpine AS server-deps
WORKDIR /build
# Tools required to compile better-sqlite3 / bcrypt native bindings
RUN apk add --no-cache python3 make g++
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 3: final runtime ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/openskill.db \
    STORAGE_DIR=/app/data/storage
WORKDIR /app

# Server source + production deps
COPY --from=server-deps /build/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY server/sql ./server/sql

# Built frontend served by Fastify @fastify/static
COPY --from=frontend-build /build/dist ./frontend/dist

# Persistent data volume mount point
RUN mkdir -p /app/data/storage/skills

EXPOSE 3000
WORKDIR /app/server
CMD ["node", "src/index.js"]
