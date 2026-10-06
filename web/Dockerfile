# syntax=docker/dockerfile:1
#
# OpesVault self-hosted server (docs/20): one Node process serving the API and the built app.
#
#   docker build -t opesvault-server .
#
# Behind a TLS-intercepting proxy, pass its CA for the build only (never baked into the image):
#   docker build --secret id=extra_ca,src=/path/to/ca.pem -t opesvault-server .

ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.28.0

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
WORKDIR /src
ENV CI=true

# Manifests first, so that dependency installs are cached between source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json packages/domain/
COPY packages/crypto/package.json packages/crypto/
COPY packages/vault/package.json packages/vault/
COPY packages/backend-http/package.json packages/backend-http/
COPY packages/ui/package.json packages/ui/
COPY apps/app/package.json apps/app/
COPY apps/server/package.json apps/server/

RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate && \
    pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @opesvault/server build

# The web app for production: the real services (server + encrypted vault), no component catalog.
RUN VITE_SERVICES=real pnpm --filter @opesvault/app build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    OPESVAULT_DATA_DIR=/data \
    OPESVAULT_STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build /src/apps/server/dist/server.mjs ./server.mjs
COPY --from=build /src/apps/app/dist ./public
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.mjs"]
