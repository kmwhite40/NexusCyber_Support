# Nexus Web (Next.js) — built standalone. The web app only talks to the API over HTTP,
# so it builds independently of the api workspace.
#
# Build from the repo root:
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_BASE=http://localhost:4000/api/v1 -t nexus-web .
#
# NEXT_PUBLIC_* values are inlined at BUILD time; set it to the URL the *browser* uses.

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/web/package.json ./
RUN npm install --no-audit --no-fund
COPY apps/web ./
ARG NEXT_PUBLIC_API_BASE=http://localhost:4000/api/v1
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE}
RUN npm run build

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Next standalone output bundles only the needed node_modules.
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
