# Built from the repo root so the workspace and @dash/shared are in scope:
#   docker build -f apps/api/Dockerfile .
FROM node:24-alpine

# Corporate proxy intercepts TLS, so the RTrust CA chain must be trusted before
# the first network call (pnpm install) as well as at runtime. update-ca-certificates
# covers OpenSSL consumers; Node keeps its own bundled store, so it additionally
# needs NODE_EXTRA_CA_CERTS pointing at a single concatenated PEM.
COPY certs/ /usr/local/share/ca-certificates/
# awk 1, not cat: the .crt files lack trailing newlines, and plain cat would
# fuse END/BEGIN lines into one, breaking PEM parsing ("bad end line").
RUN awk 1 /usr/local/share/ca-certificates/*.crt > /etc/ssl/corporate-ca-bundle.pem \
  && apk add --no-cache ca-certificates \
  && update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/corporate-ca-bundle.pem

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
