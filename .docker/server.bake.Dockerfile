# ==============================================================================
# MODULE DOCKERFILE
# This file is not meant to be built standalone. It is consumed by the 
# docker-bake.hcl files in the parent monorepos.
# ==============================================================================

ARG PRODUCT_VERSION
ARG BUILD_ROOT
ARG TARGETARCH

#### BASE ####
FROM ubuntu:24.04 AS web-base
    RUN apt-get update && \
        apt-get install -y ca-certificates curl gnupg openjdk-21-jdk wget zip brotli bzip2 && \
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
        apt-get install -y nodejs && \
        npm install -g @yao-pkg/pkg grunt-cli && \
        rm -rf /var/lib/apt/lists/*

#### SERVER ####
FROM web-base AS server

ENV PRODUCT_VERSION=${PRODUCT_VERSION}

COPY server/Common/package*.json /server/Common/
RUN --mount=type=cache,target=/root/.npm cd /server/Common && npm install

COPY server/DocService/package*.json /server/DocService/
RUN --mount=type=cache,target=/root/.npm cd /server/DocService && npm install

COPY server/FileConverter/package*.json /server/FileConverter/
RUN --mount=type=cache,target=/root/.npm cd /server/FileConverter && npm install

COPY server/Metrics/package*.json /server/Metrics/
RUN --mount=type=cache,target=/root/.npm cd /server/Metrics && npm install

COPY server/AdminPanel/server/package*.json /server/AdminPanel/server/
RUN --mount=type=cache,target=/root/.npm cd /server/AdminPanel/server && npm install

COPY server/AdminPanel/client/package*.json /server/AdminPanel/client/
RUN --mount=type=cache,target=/root/.npm cd /server/AdminPanel/client && npm install

COPY server/ /server

ENV BUILD_ROOT=${BUILD_ROOT}

RUN TARGETARCH_PKG=$(echo "$TARGETARCH" | sed 's/amd64/x64/') && \
    cd /server/Common && \
    sed "s|\(const buildVersion = \).*|\1'${PRODUCT_VERSION}';|" -i sources/commondefines.js && \
    cd /server/DocService && \
    pkg . -t linux-"$TARGETARCH_PKG" --node-options="--max_old_space_size=4096" -o "${BUILD_ROOT}/docservice" && \
    cd /server/FileConverter && \
    pkg . -t linux-"$TARGETARCH_PKG" --node-options="--max_old_space_size=4096" -o "${BUILD_ROOT}/fileconverter" && \
    cd /server/Metrics && \
    pkg . -t linux-"$TARGETARCH_PKG" --node-options="--max_old_space_size=4096" -o "${BUILD_ROOT}/metrics" && \
    cd /server/AdminPanel/server && \
    pkg . -t linux-"$TARGETARCH_PKG" --node-options="--max_old_space_size=4096" -o "${BUILD_ROOT}/adminpanel"

RUN cd /server/AdminPanel/client && npm run build