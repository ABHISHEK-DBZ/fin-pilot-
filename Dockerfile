# FinPilot — production container image.
# Node 26 runs TypeScript directly (type stripping); no build step, no native deps.
FROM node:26-alpine

WORKDIR /app

# Install dependencies (typescript for CI typecheck only; runtime has zero deps)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

# Application source
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY data/policies ./data/policies

# Persistent state (SQLite). On platforms with a mounted disk, point
# FINPILOT_DB_PATH at the mount, e.g. /data/finpilot.db
RUN mkdir -p /app/data
ENV FINPILOT_DB_PATH=/app/data/finpilot.db \
    FINPILOT_DEMO_SEED=2026 \
    NODE_ENV=production

# Render/Railway/Fly set PORT; default matches local dev
ENV PORT=4310
EXPOSE 4310

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:$PORT/api/health > /dev/null 2>&1 || exit 1

CMD ["node", "apps/api/src/server/main.ts"]
