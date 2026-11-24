FROM node:24.22.3-trixie-slim@sha256:6709bf854652e2d21610e952df82ff9c0b98cc7315acdce75236bbb66bd8aa06 AS base
WORKDIR /app

FROM base AS workspace
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/dispatcher/package.json apps/dispatcher/package.json

FROM workspace AS build
RUN npm ci --workspace=@founders-lens/api --include-workspace-root --include=dev
COPY tsconfig.base.json prisma.config.ts ./
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/prisma/schema.prisma apps/api/prisma/schema.prisma
COPY apps/api/src apps/api/src
RUN npm run db:generate && npm run build --workspace=@founders-lens/api

FROM workspace AS dependencies
# Install the API as a standalone package, retaining monorepo lock resolutions.
RUN node --input-type=module -e '\
    import { readFileSync, writeFileSync } from "node:fs"; \
    const read = path => JSON.parse(readFileSync(path, "utf8")); \
    const { name, version, dependencies } = read("apps/api/package.json"); \
    const { overrides } = read("package.json"); \
    const lock = read("package-lock.json"); \
    for (const [path, entry] of Object.entries(lock.packages)) { \
      if (path.startsWith("apps/") || entry.link) delete lock.packages[path]; \
    } \
    Object.assign(lock, { name, version }); \
    lock.packages[""] = { name, version, dependencies }; \
    writeFileSync("package-lock.json", JSON.stringify(lock)); \
    writeFileSync("package.json", JSON.stringify({ name, version, dependencies, overrides }));' \
    && npm ci --omit=dev --omit=peer --ignore-scripts

FROM gcr.io/distroless/cc-debian13:nonroot-amd64@sha256:a10bdce4a54ae11746dd88386f9860c1d178d137b56166a620898ba1bf6001cd
WORKDIR /app
ENV NODE_ENV=production
ARG SOURCE_SHA
LABEL org.opencontainers.image.source="https://github.com/rohnn-afk/Founders-Lens" \
      org.opencontainers.image.revision=$SOURCE_SHA
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=base /usr/local/bin/node /usr/local/bin/node
COPY --from=workspace /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=workspace /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
USER 1000:1000
CMD ["node", "apps/api/dist/main.js"]
