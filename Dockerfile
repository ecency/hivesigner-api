FROM node:18.19.1-alpine

WORKDIR /var/app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive --production=true

COPY . .

# Drop root for the runtime. The app only reads from the image, so nothing here
# needs write access; the install above already ran as root and is complete.
# `node` is a non-root user the official image ships.
USER node

ENV API_PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${API_PORT}/_health" || exit 1

CMD ["npm", "start"]
