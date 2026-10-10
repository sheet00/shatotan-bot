FROM node:latest

# OS dependencies need root only while building the image.
ARG PLAYWRIGHT_VERSION=1.64.0
RUN npx --yes playwright@${PLAYWRIGHT_VERSION} install-deps chromium

WORKDIR /app
USER node
CMD ["sh", "-c", "npm ci && npx playwright install chromium && exec npm start"]
