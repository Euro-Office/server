# ==============================================================================
# MODULE DOCKERFILE
# This file is not meant to be built standalone. It is consumed by the 
# docker-bake.hcl files in the parent monorepos.
# ==============================================================================

#### BASE ####
# The node binary built with here is also the one shipped to run the services.
FROM node:26.13.1-bookworm-slim AS node

FROM ubuntu:24.04 AS web-base
    COPY --from=node /usr/local/bin/node /usr/local/bin/
    COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
    COPY --from=node /usr/local/LICENSE /usr/local/share/node/LICENSE
    RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
        ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
        apt-get update && \
        apt-get install -y ca-certificates curl gnupg openjdk-21-jdk wget zip brotli bzip2 && \
        npm install -g grunt-cli && \
        rm -rf /var/lib/apt/lists/*

#### SERVER ####
FROM web-base AS server

    ARG PRODUCT_VERSION
    ARG COMPANY_NAME
    ARG BUILD_ROOT
    ARG PRODUCT_NAME

    ARG BRANDING_DIR

    ENV PRODUCT_VERSION=${PRODUCT_VERSION}

    COPY server/Common/package.json server/Common/npm-shrinkwrap.json /server/Common/
    RUN --mount=type=cache,target=/root/.npm cd /server/Common && npm ci --omit=dev

    COPY server/DocService/package.json server/DocService/npm-shrinkwrap.json /server/DocService/
    RUN --mount=type=cache,target=/root/.npm cd /server/DocService && npm ci --omit=dev

    COPY server/FileConverter/package.json server/FileConverter/npm-shrinkwrap.json /server/FileConverter/
    RUN --mount=type=cache,target=/root/.npm cd /server/FileConverter && npm ci --omit=dev

    COPY server/Metrics/package.json server/Metrics/npm-shrinkwrap.json /server/Metrics/
    RUN --mount=type=cache,target=/root/.npm cd /server/Metrics && npm ci --omit=dev

    COPY server/AdminPanel/server/package*.json /server/AdminPanel/server/
    RUN --mount=type=cache,target=/root/.npm cd /server/AdminPanel/server && npm ci --omit=dev

    COPY server/AdminPanel/client/package*.json /server/AdminPanel/client/
    RUN --mount=type=cache,target=/root/.npm cd /server/AdminPanel/client && npm ci

    COPY server/ /server

    ### Branding
    COPY --from=brand-icons /[s]erver /server/

    ENV BUILD_ROOT=${BUILD_ROOT}

    RUN cd /server/Common && \
        sed "s|\(const buildVersion = \).*|\1'${PRODUCT_VERSION}';|" -i sources/commondefines.js && \
        /server/.docker/install-runtime.sh "${BUILD_ROOT}/server" && \
        mkdir -p "${BUILD_ROOT}/server/license" && \
        cp /usr/local/share/node/LICENSE "${BUILD_ROOT}/server/license/NodeJS.license"

    ENV APP_NAME=${COMPANY_NAME}

    RUN cd /server/AdminPanel/client && \
        npm run build