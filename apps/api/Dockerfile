# Nexus API — multi-stage build. Built standalone (the API imports nothing from the
# web workspace), which keeps the runtime image lean.
#
# Build from the repo root:  docker build -f apps/api/Dockerfile -t nexus-api .

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app/apps/api
COPY apps/api/package.json apps/api/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY apps/api/src ./src
# Compile TS -> dist, then copy the .sql migrations (tsc does not emit them).
RUN npm run build \
 && mkdir -p dist/db/migrations \
 && cp src/db/migrations/*.sql dist/db/migrations/

# ---------- production deps ----------
FROM node:20-alpine AS prod-deps
WORKDIR /app/apps/api
COPY apps/api/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---------- runtime ----------
FROM node:20-alpine AS runtime
# The commit this image was built from. Surfaced on /healthz so a deploy can verify that the
# container answering is the one it just pushed, rather than the previous one still serving
# through the swap.
ARG BUILD_SHA=unknown
ENV BUILD_SHA=$BUILD_SHA
WORKDIR /app/apps/api
ENV NODE_ENV=production \
    API_PORT=4000
COPY apps/api/package.json ./
COPY --from=prod-deps /app/apps/api/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
USER node
EXPOSE 4000
# Liveness/readiness are served at /healthz and /readyz.
CMD ["node", "dist/server.js"]
