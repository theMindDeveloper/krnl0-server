# syntax=docker/dockerfile:1.7
# KRNL0 server image (F18, NF4). Multi-arch: linux/amd64, linux/arm64.
#
#   docker build -t krnl0-server .
#   docker run -d -p 8443:8443 -v krnl0-data:/data krnl0-server
#
# The KRNL0 web app is copied from ./web (CI fills it from the app's release;
# empty means the website shows a "not installed yet" page).

ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
# No install scripts: nothing in this server needs a native build.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && find dist -name "*.map" -delete

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="KRNL0 server" \
      org.opencontainers.image.description="Your own KRNL0 website and sync" \
      org.opencontainers.image.source="https://github.com/theMindDeveloper/krnl0-server" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    KRNL0_DATA_DIR=/data \
    KRNL0_IN_DOCKER=1 \
    KRNL0_BIND=0.0.0.0

WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY bin ./bin
COPY web ./web
COPY public ./public

# `krnl0 <command>` inside the container (docker exec -it krnl0 krnl0 status).
# npm/yarn are not needed at runtime: removed to shrink what an attacker could use.
RUN printf '#!/bin/sh\nexec node /app/bin/krnl0.js "$@"\n' > /usr/local/bin/krnl0 \
 && chmod 0755 /usr/local/bin/krnl0 \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data \
 && chown node:node /data \
 && chmod 0700 /data

USER node
VOLUME ["/data"]
EXPOSE 8443

HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
  CMD ["node", "/app/dist/healthcheck.js"]

ENTRYPOINT ["node", "/app/bin/krnl0.js"]
CMD ["start"]
