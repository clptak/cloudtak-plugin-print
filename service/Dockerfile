# Debian, not Alpine.
#
# CloudTAK's other task images are node:*-alpine, but Playwright's Chromium is
# only properly supported on Debian/Ubuntu — on Alpine you end up hand-installing
# the distro chromium and pinning executablePath, which is a maintenance trap.
# The base image is the one place this service deliberately departs from the
# house pattern.
FROM node:24-bookworm-slim

ENV APP_ROOT=/workspace
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

WORKDIR $APP_ROOT

COPY package*.json ./

RUN npm install --include=dev

# Chromium plus its system libraries. This is the bulk of the image size.
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY . ./

RUN npm run lint \
    && npm run check \
    && npm run build

EXPOSE 5010

CMD ["npm", "run", "prod"]
