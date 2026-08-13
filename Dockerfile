# syntax=docker/dockerfile:1.7

FROM node:26-trixie-slim AS build

ARG PNPM_VERSION=11.13.1
ARG RESOURCE_VERSION=""

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV RESOURCE_VERSION=$RESOURCE_VERSION
WORKDIR /workspace

RUN npm install --global "pnpm@${PNPM_VERSION}" \
 && pnpm --version

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json

# Build-only dependencies stay in this disposable stage. Optional platform
# packages are required here by tools such as esbuild.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY scripts scripts
COPY pow-wasm pow-wasm
COPY client client
COPY server server

# The deployed server tree contains production dependencies only and omits the
# optional SQLite driver. Only that tree is copied into the runtime image.
RUN pnpm build \
 && pnpm --filter server deploy --prod --no-optional --legacy /runtime/server

FROM gcr.io/distroless/nodejs26-debian13:nonroot AS runtime

ARG OCI_SOURCE=""
ARG OCI_REVISION=""
ARG OCI_VERSION=""

LABEL org.opencontainers.image.title="csgofriberg" \
      org.opencontainers.image.description="PostgreSQL-only csgofriberg game server and web client" \
      org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.revision=$OCI_REVISION \
      org.opencontainers.image.version=$OCI_VERSION

ENV NODE_ENV=production \
    DB_CLIENT=pg \
    PORT=3000

WORKDIR /app

COPY --from=build --chown=nonroot:nonroot /runtime/server/node_modules ./server/node_modules
COPY --from=build --chown=nonroot:nonroot /workspace/server/dist ./server/dist
COPY --from=build --chown=nonroot:nonroot /workspace/client/dist ./client/dist

USER nonroot
EXPOSE 3000

CMD ["server/dist/index.js"]
