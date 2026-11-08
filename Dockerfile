# syntax=docker/dockerfile:1.7

FROM node:26-trixie-slim AS build

ARG PNPM_VERSION=11.13.1
ARG RESOURCE_VERSION=""
ARG OCI_SOURCE="https://github.com/shnlfriberg/csgofriberg"
ARG OCI_REVISION=""
ARG OCI_VERSION=""
ARG OCI_CREATED=""
ARG RELEASE_TAG=""

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV RESOURCE_VERSION=$RESOURCE_VERSION
ENV OCI_SOURCE=$OCI_SOURCE OCI_REVISION=$OCI_REVISION OCI_VERSION=$OCI_VERSION OCI_CREATED=$OCI_CREATED RELEASE_TAG=$RELEASE_TAG BUILD_REQUIRE_GIT=true
WORKDIR /workspace

RUN npm install --global "pnpm@${PNPM_VERSION}" \
 && pnpm --version

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
COPY packages/location-core/package.json packages/location-core/package.json
COPY packages/card-link-core/package.json packages/card-link-core/package.json

# Build-only dependencies stay in this disposable stage. Skip lifecycle scripts
# during the broad install so the local-only SQLite driver cannot invoke
# node-gyp; esbuild is rebuilt explicitly for the build platform below.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm rebuild esbuild

COPY scripts scripts
COPY pow-wasm pow-wasm
COPY client client
COPY server server
COPY packages packages

# The deployed server tree contains production dependencies, including sharp's
# optional platform binaries. Production uses PostgreSQL; SQLite remains local.
RUN pnpm build \
 && pnpm --filter server deploy --prod --legacy /runtime/server \
 && mkdir -p /runtime/location-assets

FROM gcr.io/distroless/nodejs26-debian13:nonroot AS runtime

ARG OCI_SOURCE="https://github.com/shnlfriberg/csgofriberg"
ARG OCI_REVISION=""
ARG OCI_VERSION=""
ARG OCI_CREATED=""

LABEL org.opencontainers.image.title="csgofriberg" \
      org.opencontainers.image.description="PostgreSQL-only csgofriberg game server and web client" \
      org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.revision=$OCI_REVISION \
      org.opencontainers.image.version=$OCI_VERSION \
      org.opencontainers.image.created=$OCI_CREATED

ENV NODE_ENV=production \
    DB_CLIENT=pg \
    PORT=3000

WORKDIR /app

COPY --from=build --chown=nonroot:nonroot /runtime/server/node_modules ./server/node_modules
COPY --from=build --chown=nonroot:nonroot /workspace/server/dist ./server/dist
COPY --from=build --chown=nonroot:nonroot /workspace/client/dist ./client/dist
COPY --from=build --chown=nonroot:nonroot /runtime/location-assets ./location-assets
ENV LOCATION_ASSET_DIR=/app/location-assets

USER nonroot
EXPOSE 3000

CMD ["server/dist/index.js"]
