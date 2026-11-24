# Nexus Web (Next.js) — built standalone. The web app only talks to the API over HTTP,
# so it builds independently of the api workspace.
#
# Build from the repo root:
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_BASE=http://localhost:4000/api/v1 -t nexus-web .
#
# NEXT_PUBLIC_* values are inlined at BUILD time; set it to the URL the *browser* uses.

# ---------- build ----------
# Installs EXACTLY what package-lock.json records (npm ci), never "latest within the semver range".
# A plain `npm install` of apps/web/package.json used to resolve fresh versions on every build: on
# 2026-11-17 csstype 3.2.4 shipped and broke the type check of every image build, while the
# lockfile (3.2.3) kept local and CI test builds green. Reproducible builds are also a supply-chain
# control: a dependency cannot change in production without a reviewed lockfile change.
FROM node:20-alpine AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
# npm ci validates the lockfile against every workspace manifest, so all of them are copied;
# only the web workspace's dependencies are installed.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace apps/web --include-workspace-root=false --no-audit --no-fund
COPY apps/web apps/web/
WORKDIR /repo/apps/web
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
# Dependencies are hoisted to the workspace root, so Next traces from /repo and the standalone
# bundle mirrors the monorepo layout: the server lives at apps/web/server.js.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
