FROM node:24.22.3-bookworm-slim@sha256:e0e989b967dacc279681ed81774b2ce9eeebbb0efb8e0c427573235bebf1eda1 AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS workspace
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
RUN npm ci --workspace=@founders-lens/api --omit=dev && npm cache clean --force

FROM base
ENV NODE_ENV=production
ARG SOURCE_SHA
LABEL org.opencontainers.image.source="https://github.com/rohnn-afk/Founders-Lens" \
      org.opencontainers.image.revision=$SOURCE_SHA
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=workspace /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
USER node
CMD ["node", "apps/api/dist/main.js"]
