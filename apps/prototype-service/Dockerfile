FROM registry.sberdevices.ru/rndml/devops/dockerfiles/nodejs-runtime-24-16-alpine:24.16.0 AS build
ARG NPM_REGISTRY=https://nexus.sberdevices.ru/repository/npm-proxy/
ENV npm_config_registry=${NPM_REGISTRY} \
    npm_config_fetch_timeout=600000 \
    npm_config_fetch_retries=5
RUN npm install --global npm@11.17.0 --ignore-scripts --no-audit --no-fund
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/prototype-service/package.json apps/prototype-service/package.json
COPY packages/prototype-worker/package.json packages/prototype-worker/package.json
COPY packages/data-schemas/package.json packages/data-schemas/package.json
COPY packages/data-provider/package.json packages/data-provider/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/client/package.json packages/client/package.json
COPY api/package.json api/package.json
COPY client/package.json client/package.json
RUN npm ci --ignore-scripts --workspace=apps/prototype-service --workspace=packages/prototype-worker --workspace=packages/data-schemas --workspace=packages/data-provider --include-workspace-root=false
COPY packages/data-provider packages/data-provider
COPY packages/data-schemas packages/data-schemas
COPY packages/prototype-worker packages/prototype-worker
RUN npm run build --workspace=packages/data-provider && npm run build --workspace=packages/data-schemas
RUN npm run build --workspace=packages/prototype-worker

FROM registry.sberdevices.ru/rndml/devops/dockerfiles/nodejs-runtime-24-16-alpine:24.16.0 AS production-dependencies
ARG NPM_REGISTRY=https://nexus.sberdevices.ru/repository/npm-proxy/
ENV npm_config_registry=${NPM_REGISTRY} \
    npm_config_fetch_timeout=600000 \
    npm_config_fetch_retries=5
RUN npm install --global npm@11.17.0 --ignore-scripts --no-audit --no-fund
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/prototype-service/package.json apps/prototype-service/package.json
COPY packages/prototype-worker/package.json packages/prototype-worker/package.json
COPY packages/data-schemas/package.json packages/data-schemas/package.json
COPY packages/data-provider/package.json packages/data-provider/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/client/package.json packages/client/package.json
COPY api/package.json api/package.json
COPY client/package.json client/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace=apps/prototype-service --workspace=packages/prototype-worker --workspace=packages/data-schemas --workspace=packages/data-provider --include-workspace-root=false

FROM registry.sberdevices.ru/rndml/devops/dockerfiles/nodejs-runtime-24-16-alpine:24.16.0 AS runtime
RUN sed -i 's#https://dl-cdn.alpinelinux.org/alpine#https://nexus.sberdevices.ru/repository/alpine-apk#' /etc/apk/repositories && \
    apk add --no-cache tar zstd && addgroup -g 10001 -S prototype && adduser -u 10001 -S -D -H -G prototype prototype
WORKDIR /app
COPY --from=production-dependencies --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=10001:10001 /app/apps/prototype-service/package.json ./apps/prototype-service/package.json
COPY --from=production-dependencies --chown=10001:10001 /app/packages/prototype-worker/package.json ./packages/prototype-worker/package.json
COPY --from=production-dependencies --chown=10001:10001 /app/packages/data-schemas/package.json ./packages/data-schemas/package.json
COPY --from=production-dependencies --chown=10001:10001 /app/packages/data-provider/package.json ./packages/data-provider/package.json
COPY --from=build --chown=10001:10001 /app/packages/data-schemas/dist ./packages/data-schemas/dist
COPY --from=build --chown=10001:10001 /app/packages/data-provider/dist ./packages/data-provider/dist
COPY --from=build --chown=10001:10001 /app/packages/prototype-worker/dist ./packages/prototype-worker/dist
COPY --chown=10001:10001 apps/prototype-service/src ./apps/prototype-service/src
COPY --chown=10001:10001 apps/prototype-service/assets ./apps/prototype-service/assets
COPY --chown=10001:10001 apps/prototype-service/deploy/gateway/release-lock.json ./apps/prototype-service/deploy/gateway/release-lock.json
RUN mkdir -p /var/lib/prototype && chown 10001:10001 /var/lib/prototype
ENV NODE_ENV=production PROTOTYPE_BIND_HOST=0.0.0.0 LOG_TO_FILE=false PROTOTYPE_WORKSPACE_DIR=/var/lib/prototype
EXPOSE 3090
USER 10001:10001
ENTRYPOINT ["node", "apps/prototype-service/src/entrypoint.js"]

FROM mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS build-qa-runtime
RUN apt-get update && apt-get install --no-install-recommends -y zstd
RUN groupadd --gid 10001 prototype && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin prototype
WORKDIR /app
COPY --from=production-dependencies --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=10001:10001 /app/apps/prototype-service/package.json ./apps/prototype-service/package.json
COPY --from=production-dependencies --chown=10001:10001 /app/packages/prototype-worker/package.json ./packages/prototype-worker/package.json
COPY --from=production-dependencies --chown=10001:10001 /app/packages/data-schemas/package.json ./packages/data-schemas/package.json
COPY --from=production-dependencies --chown=10001:10001 /app/packages/data-provider/package.json ./packages/data-provider/package.json
COPY --from=build --chown=10001:10001 /app/packages/data-schemas/dist ./packages/data-schemas/dist
COPY --from=build --chown=10001:10001 /app/packages/data-provider/dist ./packages/data-provider/dist
COPY --from=build --chown=10001:10001 /app/packages/prototype-worker/dist ./packages/prototype-worker/dist
COPY --chown=10001:10001 apps/prototype-service/src ./apps/prototype-service/src
COPY --chown=10001:10001 apps/prototype-service/assets ./apps/prototype-service/assets
COPY --chown=10001:10001 apps/prototype-service/deploy/gateway/release-lock.json ./apps/prototype-service/deploy/gateway/release-lock.json
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER 10001:10001
ENTRYPOINT ["node", "apps/prototype-service/src/entrypoint.js"]

FROM build-qa-runtime AS mvp-toolchain
USER 0
COPY api/server/services/Prototypes/local-agent-assets/template /opt/prototype/template
# Network is available only while the trusted, versioned image is built. Runtime
# generation/build Jobs use these immutable dependencies without npm installation.
RUN npm ci --prefix /opt/prototype/template --include=dev --ignore-scripts --no-audit --no-fund
USER 10001:10001

FROM runtime AS final
