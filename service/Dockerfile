# Debian, not Alpine.
#
# CloudTAK's other task images are node:*-alpine, but Playwright's Chromium is
# only properly supported on Debian/Ubuntu — on Alpine you end up hand-installing
# the distro chromium and pinning executablePath, which is a maintenance trap.
# The base image is the one place this service deliberately departs from the
# house pattern.
FROM node:24-bookworm-slim

# Where Chromium comes from.
#
#   playwright  (default) — download the pinned build from Playwright's CDN.
#                           Exact version match, but needs CDN access at build
#                           time, which some networks block.
#   distro                 — apt-get install chromium and point the service at
#                           it with PRINT_CHROMIUM_PATH. Works with no CDN
#                           access; the Chromium version is whatever Debian
#                           ships, so check GET /print-api/smoke/webgl after.
ARG CHROMIUM_SOURCE=playwright
ARG CHROMIUM_PATH=

ENV APP_ROOT=/workspace
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production
ENV PRINT_CHROMIUM_PATH=${CHROMIUM_PATH}

WORKDIR $APP_ROOT

COPY package*.json ./

RUN npm install --include=dev

# Fonts are for the phase-3 page layout, not the map: MapLibre renders map labels
# from SDF glyph tiles, so system fonts do not affect the map itself.
RUN set -eux; \
    if [ "$CHROMIUM_SOURCE" = "distro" ]; then \
        apt-get update; \
        apt-get install -y --no-install-recommends chromium fonts-dejavu-core fonts-liberation; \
    else \
        npx playwright install --with-deps chromium; \
        apt-get update; \
        apt-get install -y --no-install-recommends fonts-dejavu-core fonts-liberation; \
    fi; \
    rm -rf /var/lib/apt/lists/*

COPY . ./

RUN npm run lint \
    && npm run check \
    && npm run build

EXPOSE 5010

CMD ["npm", "run", "prod"]
