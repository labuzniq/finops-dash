# Built from the repo root so the workspace and @dash/shared are in scope:
#   docker build -f apps/api/Dockerfile .
FROM node:24-alpine

RUN corepack enable
WORKDIR /app

# Manifests first — this layer caches until a dependency actually changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @dash/shared build && pnpm --filter @dash/api build

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "apps/api/dist/index.js"]
